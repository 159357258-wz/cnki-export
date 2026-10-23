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
import time

import pandas as pd

BATCH_LIMIT = 500  # 知网勾选上限（实测）


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


def run_ego(ego, script_path, replacements):
    """跑一个 ego-browser nodejs 脚本

    ⚠️ 不用环境变量传参：实测 ego-browser 的 nodejs 子进程不继承父进程 env
       （CNKI_QUERY 传不进去，脚本读到 undefined，落到默认值）。
       改为读 JS 模板后替换 __PLACEHOLDER__ 占位符，再用 -e 传入。

    ⚠️ 脚本里的 `// __CAPTCHA_SNIPPET__` 会被替换成 _captcha.js 的内容
       （ego-browser 的 -e 不支持 import，只能内联）。
    """
    with open(script_path, encoding="utf-8") as f:
        script = f.read()

    # 内联滑块检测片段
    captcha_path = os.path.join(os.path.dirname(script_path), "_captcha.js")
    if "__CAPTCHA_SNIPPET__" in script:
        if not os.path.isfile(captcha_path):
            raise SystemExit("❗ 缺少 %s（滑块检测片段）" % captcha_path)
        with open(captcha_path, encoding="utf-8") as f:
            snippet = f.read()
        script = script.replace("// __CAPTCHA_SNIPPET__", snippet)

    for k, v in replacements.items():
        script = script.replace(k, v)

    r = subprocess.run(
        [ego, "nodejs", "-e", script],
        capture_output=True, text=True, encoding="utf-8", errors="ignore",
        timeout=2400,   # 留出滑块最长等待（5 分钟）+ 余量
    )
    return r.returncode, (r.stdout or ""), (r.stderr or "")


def step1_collect(ego, journal, year, out_dir):
    """收集全部 filename"""
    print("\n【第 1 步】检索并收集文件名")
    fj = os.path.join(out_dir, "filenames.json")
    query = "LY='%s' AND YE=%s" % (journal, year)
    print("  检索式:", query)
    script = os.path.join(os.path.dirname(__file__), "cnki_collect_filenames.js")
    code, out, err = run_ego(ego, script, {
        "__CNKI_QUERY__": js_str(query),
        "__CNKI_OUT__": js_str(fj),
    })
    print(out[-2000:] if out else "(无输出)")
    if err.strip():
        if "滑块" in err or "captcha" in err.lower() or "验证超时" in err:
            print("[滑块未完成] 请先手动把浏览器里的知网验证过掉，再重跑")
        print("[stderr]", err[-800:])
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
        code, out, err = run_ego(ego, script, {
            "__CNKI_FILENAMES__": js_str(fn),
            "__CNKI_DL_DIR__": js_str(dl_dir),
        })
        print(out[-1200:] if out else "(无输出)")
        if err.strip() and "Error" in err:
            print("[stderr]", err[-500:])

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
    ap = argparse.ArgumentParser(description="知网批量导出（按期刊+年份）")
    ap.add_argument("--journal", required=True, help="期刊名（与知网「文献来源」字段一致）")
    ap.add_argument("--year", required=True, type=int, help="年份")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--dry-run", action="store_true", help="只导 3 条做自检")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    ego = find_ego_browser()
    dl = find_download_dir()
    print("ego-browser:", ego)
    print("下载目录:", dl)

    if not dl:
        raise SystemExit("❗ 找不到下载目录。请先在 ego-lite 里随便下载一个文件，或用 --dl-dir 指定")
    os.makedirs(dl, exist_ok=True)

    data = step1_collect(ego, args.journal, args.year, args.out)
    files = step2_export(ego, data, dl, args.out, dry_run=args.dry_run)

    if args.dry_run:
        print("\n自检完成。检查上面是否有「新增 xls」——有就说明流程通了。")
        return

    if len(files) < 1:
        raise SystemExit("❗ 一批都没导出来")

    # 有几批就合并几个（可能缺批）
    expect = (len(data) + BATCH_LIMIT - 1) // BATCH_LIMIT
    if len(files) < expect:
        print("\n⚠️ 预期 %d 批，实际只导到 %d 批 —— 合并结果是部分数据" % (expect, len(files)))

    step3_merge(files, args.journal, args.year, args.out)


if __name__ == "__main__":
    main()
