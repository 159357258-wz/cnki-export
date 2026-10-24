# -*- coding: utf-8 -*-
"""知网批量导出（参数化封装）

## 用法

    python cnki_export.py --journal "价格理论与实践" --year 2020 --out F:\\data

    # 先自检 3 条（推荐）
    python cnki_export.py --journal "价格理论与实践" --year 2020 --out F:\\data --dry-run

## 前置条件

1. 安装了 ego-lite（`ego-browser` 命令可用）
2. 浏览器里有真实机构登录态（先手动登一次知网）
3. 当前进程**不是管理员**（ego-browser 拒绝在 elevated 下运行）

## 它做什么

1. 探测 ego-browser 路径与下载目录
2. 检索「期刊 + 年份」，收集全部 data-filename
3. 自检：先导 3 条，确认 URL 能出数据
4. 按 500 条一批，逐批导出
5. 合并、去重、中文化列名、按类型清洗
6. 输出 CSV

## 输出

    <out>/<期刊>_<年份>_全部N条.csv      原始全量
    <out>/<期刊>_<年份>_学术论文N条.csv  剔除书评/广告/公告
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import pandas as pd

BATCH_LIMIT = 200  # 每批条数上限（实测：500 条 → 414 Request-URI Too Large；
                   #                    300 条 → HTTP 400 Bad Request；
                   #                    200 条 → OK，URL 约 4291 字符）


def find_ego_browser():
    """找 ego-browser.exe"""
    cands = []
    for root in [r"C:\Program Files\Citro Labs", r"C:\Program Files (x86)\Citro Labs"]:
        if os.path.isdir(root):
            cands += glob.glob(os.path.join(root, "**", "ego-browser.exe"), recursive=True)
    if os.name != "nt":
        from shutil import which
        w = which("ego-browser")
        if w:
            cands.append(w)
    if not cands:
        raise SystemExit("❗ 找不到 ego-browser.exe。请先安装 ego-lite：https://lite.ego.app/")
    # 取版本号最大的
    def ver(p):
        m = re.search(r"(\d+)\.(\d+)\.(\d+)", p)
        return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)
    cands.sort(key=ver, reverse=True)
    return cands[0]


def find_download_dir():
    """从 ego-lite 的 Preferences 读下载目录"""
    roots = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Citro Labs", "ego lite", "User Data"),
        os.path.join(os.environ.get("APPDATA", ""), "Citro Labs", "ego lite", "User Data"),
    ]
    for root in roots:
        if not os.path.isdir(root):
            continue
        for prof in glob.glob(os.path.join(root, "Profile *")):
            pref = os.path.join(prof, "Preferences")
            if not os.path.isfile(pref):
                continue
            try:
                txt = open(pref, encoding="utf-8", errors="ignore").read()
                m = re.search(r'"default_directory"\s*:\s*"([^"]+)"', txt)
                if m:
                    d = m.group(1).replace("\\\\", "\\")
                    if os.path.isdir(d):
                        return d
            except Exception:
                pass
    # 兜底
    for d in [os.path.join(os.path.expanduser("~"), "Downloads")]:
        if os.path.isdir(d):
            return d
    return None


def js_str(s):
    """把 Python 字符串转成 JS 字符串字面量（含引号）"""
    return json.dumps(s, ensure_ascii=False)


def run_ego(ego, script_path, replacements, timeout=1800, label=""):
    """跑一个 ego-browser nodejs 脚本（实时流式输出）

    ⚠️ 为什么不用 subprocess.run(capture_output=True)：
       它会阻塞到进程结束，中途看不到任何输出。如果 ego-browser 卡住
       （比如浏览器没启动、页面导航死等），只能干等到 timeout（原来 2400 秒）。
       改成 Popen + 逐行读 stdout，每行实时打印。

    ⚠️ 不用环境变量传参：ego-browser 的 nodejs 子进程不继承父进程 env
       （CNKI_QUERY 传不进去，脚本读到 undefined，静默落到默认值。
       实测踩过：把 560 条的 query 写成了别人的任务）。

    ⚠️ 脚本本身用 fs.appendFileSync 写日志文件（见 JS 里的 LOG 常量）：
       console.log 的输出经 cmd /c 重定向后会被完全缓冲，拿不到实时进度。
    """
    with open(script_path, encoding="utf-8") as f:
        script = f.read()

    for k, v in replacements.items():
        script = script.replace(k, v)

    # 检查是否还有未替换的占位符（旧版曾因 env 不继承而静默用默认值）
    left = sorted(set(re.findall(r"__CNKI_[A-Z_]+__", script)))
    if left:
        raise SystemExit("❗ 未替换的占位符：%s（检查 replacements 与脚本里的名字是否一致）" % left)

    # ⚠️ 为什么写到临时 .mjs 而不是 -e 内联：
    #   ① 内联脚本受 Windows 命令行长度限制（约 32KB），长脚本会被截断
    #   ② 脚本要 import ego_kit.js，内联模式没有稳定的模块基准路径
    #   ③ -e 里只放一行 ASCII 的 import 入口，避开引号与中文转义问题
    work = os.path.join(os.path.dirname(script_path), "_run")
    os.makedirs(work, exist_ok=True)
    # label 里可能有 / : 等非法文件名字符（如「导出第 1/1 批」），先清洗
    safe = re.sub(r"[^\w\u4e00-\u9fa5\-]+", "_", (label or "run"))[:40].strip("_") or "run"
    mjs = os.path.join(work, "step_%s.mjs" % safe)
    with open(mjs, "w", encoding="utf-8") as f:
        f.write(script)

    entry = "await import('file:///%s')" % mjs.replace("\\", "/")

    if label:
        print("  [启动] %s（脚本 %d 字符 → %s，超时 %d 秒）"
              % (label, len(script), os.path.basename(mjs), timeout))

    t0 = time.time()
    proc = subprocess.Popen(
        [ego, "nodejs", "-e", entry],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="ignore",
        bufsize=1,
    )

    lines = []
    last_print = time.time()
    try:
        for line in proc.stdout:
            line = line.rstrip("\r\n")
            if line:
                elapsed = time.time() - t0
                print("    [%5.1fs] %s" % (elapsed, line))
                lines.append(line)
                last_print = time.time()
            if time.time() - t0 > timeout:
                proc.kill()
                print("    ❌ 超时 %d 秒，已终止" % timeout)
                break
    finally:
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()

    elapsed = time.time() - t0
    if label:
        print("  [完成] %s 用时 %.1f 秒，退出码 %s" % (label, elapsed, proc.returncode))

    return proc.returncode or 0, "\n".join(lines), ""


def step_check(ego, journal, year, out_dir):
    """只检查环境：打开页面 + 登录态 + 滑块 + 检索 1 次（约 8—25 秒）"""
    print("\n【检查模式】不翻页、不导出")
    query = "LY='%s' AND YE=%s" % (journal, year)
    script = os.path.join(os.path.dirname(__file__), "cnki_check.js")
    if not os.path.isfile(script):
        raise SystemExit("❗ 缺少 %s" % script)
    stamp = time.strftime("%H%M%S")
    code, out, err = run_ego(ego, script, {
        "__CNKI_QUERY__": js_str(query),
        "__CNKI_LOG__": js_str(os.path.join(out_dir, "自检_%s.log" % stamp)),
        "__CNKI_SPACE__": js_str("cnki-check-" + stamp),
    }, timeout=180, label="自检")
    if code != 0:
        raise SystemExit("❗ 自检失败（退出码 %d）" % code)
    print("\n✅ 自检通过")
    return True


def step1_collect(ego, journal, year, out_dir, max_pages=0):
    """收集全部 filename

    max_pages: >0 时只翻前 N 页（开发时用 2 快速验证收集逻辑）
    """
    print("\n【第 1 步】检索并收集文件名")
    if max_pages:
        print("  ⚠️ 只翻前 %d 页（--max-pages）" % max_pages)
    fj = os.path.join(out_dir, "filenames.json")
    query = "LY='%s' AND YE=%s" % (journal, year)
    print("  检索式:", query)
    script = os.path.join(os.path.dirname(__file__), "cnki_collect_filenames.js")
    stamp = time.strftime("%H%M%S")
    code, out, err = run_ego(ego, script, {
        "__CNKI_QUERY__": js_str(query),
        "__CNKI_OUT__": js_str(fj),
        "__CNKI_LOG__": js_str(os.path.join(out_dir, "收集_%s.log" % stamp)),
        "__CNKI_MAX_PAGES__": str(max_pages if max_pages else 80),
        "__CNKI_SPACE__": js_str("cnki-collect-" + stamp),
    }, timeout=900, label="收集文件名")
    if code != 0:
        if "滑块" in out or "验证" in out:
            print("\n[提示] 如果浏览器里出现知网滑块验证，请手动拖一下，然后重跑")
    if not os.path.isfile(fj):
        raise SystemExit("❗ 收集失败，没生成 %s" % fj)
    data = json.load(open(fj, encoding="utf-8"))
    print("  收集到 %d 条" % len(data))
    return data


def step2_export(ego, data, dl_dir, out_dir, dry_run=False):
    """分批导出"""
    if dry_run:
        data = data[:3]
        print("\n【自检模式】只导 3 条")

    batches = [data[i:i + BATCH_LIMIT] for i in range(0, len(data), BATCH_LIMIT)]
    print("\n【第 2 步】分 %d 批导出（每批 ≤%d 条）" % (len(batches), BATCH_LIMIT))

    script = os.path.join(os.path.dirname(__file__), "cnki_export_batch.js")
    downloaded = []

    for bi, batch in enumerate(batches, 1):
        print("\n  ── 第 %d/%d 批（%d 条）──" % (bi, len(batches), len(batch)))
        fn = ",".join([(d.get("db") or "CJFQ") + "!" + d["f"] for d in batch])
        ff = os.path.join(out_dir, "batch_%d.txt" % bi)
        open(ff, "w", encoding="utf-8").write(fn)

        before = set(glob.glob(os.path.join(dl_dir, "*.xls")))
        stamp = time.strftime("%H%M%S")
        code, out, err = run_ego(ego, script, {
            "__CNKI_FILENAMES__": js_str(fn),
            "__CNKI_DL_DIR__": js_str(dl_dir),
            "__CNKI_LOG__": js_str(os.path.join(out_dir, "导出_%d_%s.log" % (bi, stamp))),
            "__CNKI_SAVE_AS__": js_str(""),
            "__CNKI_SPACE__": js_str("cnki-export-%d-%s" % (bi, stamp)),
        }, timeout=300, label="导出第 %d/%d 批" % (bi, len(batches)))

        # 找新文件
        deadline = time.time() + 30
        new_files = []
        while time.time() < deadline:
            after = set(glob.glob(os.path.join(dl_dir, "*.xls")))
            new_files = sorted(after - before, key=os.path.getmtime, reverse=True)
            if new_files:
                break
            time.sleep(2)

        if new_files:
            print("  ✅ 新增: %s（%d KB）" % (
                os.path.basename(new_files[0]),
                os.path.getsize(new_files[0]) // 1024))
            downloaded.append(new_files[0])
        else:
            print("  ⚠️ 这批没拿到新文件")

    return downloaded


def step3_merge(files, journal, year, out_dir):
    """合并去重"""
    print("\n【第 3 步】合并 %d 个文件" % len(files))
    if not files:
        raise SystemExit("❗ 没有可合并的文件")

    frames = []
    for f in files:
        try:
            dfs = pd.read_html(f, encoding="utf-8")
            df = dfs[0]
            df.columns = df.iloc[0]
            df = df.iloc[1:].reset_index(drop=True)
            print("  %s → %d 条" % (os.path.basename(f), len(df)))
            frames.append(df)
        except Exception as e:
            print("  %s 读取失败: %s" % (os.path.basename(f), str(e)[:100]))

    m = pd.concat(frames, ignore_index=True)
    key = ["Title-题名", "Author-作者", "Period-期"]
    key = [k for k in key if k in m.columns]
    before = len(m)
    m = m.drop_duplicates(subset=key).reset_index(drop=True)
    print("  合并 %d 条 → 去重后 %d 条（删 %d）" % (before, len(m), before - len(m)))

    # 中文化
    rename = {
        "SrcDatabase-来源库": "来源库", "Title-题名": "题名", "Author-作者": "作者",
        "Organ-单位": "单位", "Source-文献来源": "来源", "Keyword-关键词": "关键词",
        "Summary-摘要": "摘要", "PubTime-发表时间": "发表时间", "FirstDuty-第一责任人": "第一责任人",
        "Fund-基金": "基金", "Year-年": "年", "Volume-卷": "卷", "Period-期": "期",
        "PageCount-页码": "页码", "CLC-中图分类号": "中图分类号", "ISSN-国际标准刊号": "ISSN",
        "URL-网址": "网址", "DOI-DOI": "DOI",
    }
    m = m.rename(columns=rename)

    if "期" in m.columns:
        m["期"] = pd.to_numeric(m["期"], errors="coerce").astype("Int64")
        m = m.sort_values(["期", "题名"], na_position="last").reset_index(drop=True)

    # 校验
    print("\n  === 校验 ===")
    if "年" in m.columns:
        print("  年份:", list(m["年"].unique())[:5])
    if "来源" in m.columns:
        print("  来源:", list(m["来源"].unique())[:5])
    if "摘要" in m.columns:
        n = (m["摘要"].astype(str).str.strip() != "").sum()
        print("  摘要非空: %d / %d" % (n, len(m)))

    # 分类
    def classify(r):
        t = str(r.get("题名", "")); s = str(r.get("摘要", ""))
        a = str(r.get("作者", "")).strip()
        if "选题推荐" in t or "征稿" in t or "征文" in t:
            return "选题推荐/征稿"
        if "——评" in t and ("出版社" in t or "《" in t):
            return "书评（广告性）"
        if "价格指数" in t and "点评" in t:
            return "价格指数点评"
        if "评选公告" in t or "启事" in t or "声明" in t:
            return "公告/启事"
        if a in ("", "nan", "None") or s.startswith("<正>"):
            return "其他非论文"
        return "学术论文"

    m["类型"] = m.apply(classify, axis=1)

    safe = re.sub(r'[\\/:*?"<>|]', "_", journal)
    p1 = os.path.join(out_dir, "%s_%s_全部%d条.csv" % (safe, year, len(m)))
    m.to_csv(p1, index=False, encoding="utf-8-sig")

    ac = m[m["类型"] == "学术论文"].drop(columns=["类型"]).reset_index(drop=True)
    p2 = os.path.join(out_dir, "%s_%s_学术论文%d条.csv" % (safe, year, len(ac)))
    ac.to_csv(p2, index=False, encoding="utf-8-sig")

    print("\n  === 类型分布 ===")
    for k, v in m["类型"].value_counts().items():
        print("    %-14s %3d" % (k, v))

    print("\n✅ 已保存:")
    print("   ", p1)
    print("   ", p2)
    return p1, p2


def main():
    ap = argparse.ArgumentParser(
        description="知网批量导出（按期刊+年份）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
开发验证的三种快速模式（不跑全量）：
  --check-only                只做「打开页面 + 查登录态 + 查滑块 + 检索 1 次」，不翻页不导出（约 8 秒）
  --max-pages 2 --dry-run     只翻 2 页，导出 3 条（约 12 秒）
  --reuse-filenames --dry-run 复用上次的 filenames.json，跳过收集，直接导出（约 12 秒）

真跑一年：
  --journal "中国工业经济" --year 2020 --out F:\\data
""")
    ap.add_argument("--journal", required=True, help="期刊名（与知网「文献来源」字段一致）")
    ap.add_argument("--year", required=True, type=int, help="年份")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--dry-run", action="store_true", help="只导 3 条做自检")
    ap.add_argument("--max-pages", type=int, default=0,
                    help="只翻前 N 页（0=全部）。开发时用 2 快速验证收集逻辑")
    ap.add_argument("--reuse-filenames", action="store_true",
                    help="复用 <out>/filenames.json，跳过收集阶段。改导出逻辑时用")
    ap.add_argument("--check-only", action="store_true",
                    help="只检查：打开页面 + 登录态 + 滑块 + 检索 1 次，不翻页不导出")
    ap.add_argument("--dl-dir", default="",
                    help="手动指定下载目录（默认从 ego-lite Preferences 读）")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    ego = find_ego_browser()
    dl = args.dl_dir or find_download_dir()
    print("ego-browser:", ego)
    print("下载目录:", dl)

    if not dl:
        raise SystemExit("❗ 找不到下载目录。请先在 ego-lite 里随便下载一个文件，或用 --dl-dir 指定")
    os.makedirs(dl, exist_ok=True)

    # ── 模式 1：只检查（约 8 秒）
    if args.check_only:
        print("\n【检查模式】不做翻页、不导出")
        step_check(ego, args.journal, args.year, args.out)
        return

    # ── 收集阶段
    fj = os.path.join(args.out, "filenames.json")
    if args.reuse_filenames:
        if not os.path.isfile(fj):
            raise SystemExit("❗ --reuse-filenames 但 %s 不存在，先跑一次收集" % fj)
        data = json.load(open(fj, encoding="utf-8"))
        print("\n【复用】从 %s 读到 %d 条，跳过收集" % (fj, len(data)))
    else:
        _t_col = time.time()
        data = step1_collect(ego, args.journal, args.year, args.out,
                             max_pages=args.max_pages)
        print("\n  [计时] 收集阶段 %.1f 秒" % (time.time() - _t_col))

    # ── 导出阶段
    _t_exp = time.time()
    files = step2_export(ego, data, dl, args.out, dry_run=args.dry_run)
    print("\n  [计时] 导出阶段 %.1f 秒" % (time.time() - _t_exp))

    if args.dry_run or args.max_pages:
        print("\n自检完成。检查上面是否有「新增 xls」——有就说明流程通了。")
        if args.max_pages:
            print("（--max-pages %d 只跑了前 %d 页，不是全量）" % (args.max_pages, args.max_pages))
        return

    if len(files) < 1:
        raise SystemExit("❗ 一批都没导出来")

    expect = (len(data) + BATCH_LIMIT - 1) // BATCH_LIMIT
    if len(files) < expect:
        print("\n⚠️ 预期 %d 批，实际只导到 %d 批 —— 合并结果是部分数据" % (expect, len(files)))

    _t_merge = time.time()
    step3_merge(files, args.journal, args.year, args.out)
    print("\n  [计时] 合并阶段 %.1f 秒" % (time.time() - _t_merge))


if __name__ == "__main__":
    main()
