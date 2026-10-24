/**
 * cnki_export_batch.js —— 打开导出页，全选，导出 xls
 *
 * 占位符（由 cnki_export.py 替换）：
 *   __CNKI_FILENAMES__  已带库代码前缀的 filename 串（CJFQ!xxx,CJFQ!yyy,...）
 *   __CNKI_DL_DIR__     浏览器下载目录（核对新文件）
 *   __CNKI_LOG__        日志绝对路径
 *   __CNKI_SAVE_AS__    可选：直接落盘的绝对路径（空串则走浏览器下载）
 *   __CNKI_SPACE__      ego 任务空间名
 *
 * 相比旧版的改进：
 *   ① xls 不再硬点坐标 (1003,237)，改为三级降级：
 *      page.fetch({saveAs}) → page.click(原生CDP) → page.mouse.click(坐标兜底)
 *   ② 全选后不再固定 sleep，改用 page.waitForFunction 等勾选数 > 0
 *   ③ 等下载用 fs 轮询 + 文件大小校验，不再盲等固定秒数
 *   ④ 失败时截图取证
 *
 * 用到的 ego API（10 个）：
 *   taskSpace, task.spaceId, task.page, task.finish
 *   page.goto, page.waitForSelector, page.waitForFunction, page.click,
 *   page.evaluate, page.fetch, page.mouse, page.screenshot
 */

const K = await import("file:///F:/工具/_外部技能库/cnki-export/scripts/ego_kit.js");
const fs = await import("node:fs");
const path = await import("node:path");

const FN = __CNKI_FILENAMES__;
const DL_DIR = __CNKI_DL_DIR__;
const LOG = __CNKI_LOG__;
const SAVE_AS = __CNKI_SAVE_AS__;
const SPACE = __CNKI_SPACE__;

const L = K.makeLogger(LOG);

L.log("════ 导出开始 ════");
L.log("filename 长度 " + FN.length + "，条数 " + FN.split(",").length);
L.log("下载目录 " + DL_DIR);
L.log("直存路径 " + (SAVE_AS || "（无，走浏览器下载）"));

const items = FN.split(",").map((x) => {
  const i = x.indexOf("!");
  return i > 0 ? { db: x.slice(0, i), f: x.slice(i + 1) } : { db: "CJFQ", f: x };
});

let task = null;
let page = null;
let result = { ok: false, method: "", path: "", size: 0, error: "" };

try {
  const opened = await K.openSpace(SPACE, "p1", L);
  task = opened.task;
  page = opened.page;

  // 1. 构造导出 URL（含 414 预检）
  const built = K.buildExportUrl(items);
  L.log("URL 长度 " + built.url.length + "，条数 " + built.count);
  if (built.url.length > 6000) {
    throw new Error("URL " + built.url.length + " 字符，会 414。请把批次降到 200 条以内");
  }

  // 2. 打开导出页并等 xls 链接
  const state = await K.openExportPage(page, built.url, { logger: L });
  if (state.has414) throw new Error("414 Request-URI Too Large");
  if (state.noData) throw new Error("导出页返回「暂无数据」——filename 缺 CJFQ! 前缀或条目无效");
  if (!state.hasXls) L.log("  警告：未检出 xls 链接，仍尝试全选后导出");

  // 3. 先勾全部 18 个导出字段（默认只勾 5 个，不勾就没有摘要）
  await K.selectAllFields(page, { logger: L });

  // 4. 再全选条目
  await K.selectAll(page, { logger: L });

  // 4. 等勾选生效（替代固定 sleep）
  try {
    await page.waitForFunction(
      () => {
        const boxes = [...document.querySelectorAll("input[type='checkbox']")];
        const checked = boxes.filter((b) => b.checked).length;
        const txt = document.body ? document.body.innerText : "";
        const m = txt.match(/已选\s*(\d+)/);
        const selected = m ? Number(m[1]) : checked;
        return selected > 0;
      },
      undefined,
      { timeout: 15000, polling: 100 }
    );
    L.log("  勾选已生效");
  } catch (e) {
    L.log("  等勾选超时（可能默认全选）");
  }

  // 5. 下载：fetch 直存 → click → mouse 兜底
  const before = await K.snapshotDir(DL_DIR);
  if (DL_DIR) L.log("  下载目录原有 " + before.size + " 个文件");

  const dl = await K.downloadXls(page, { saveAs: SAVE_AS || "", logger: L });
  result.method = dl.method;

  if (dl.method === "fetch" && dl.size > 1024) {
    result.ok = true;
    result.path = dl.path;
    result.size = dl.size;
    L.log("  直接落盘成功，无需等浏览器下载");
  } else {
    // 6. 等浏览器把文件写到下载目录
    const p = await K.waitForNewFile(DL_DIR, before, { timeout: 45000, logger: L });
    if (p) {
      const st = fs.statSync(p);
      result.ok = true;
      result.path = p;
      result.size = st.size;
    } else {
      throw new Error("等了 45 秒没有新 xls 文件");
    }
  }

  L.log("导出成功 method=" + result.method + " path=" + result.path +
    " size=" + Math.round(result.size / 1024) + " KB");

} catch (e) {
  result.error = String(e).slice(0, 300);
  L.log("❌ " + result.error);

  if (page) {
    try {
      const shot = (LOG.replace(/\.log$/i, "")) + "_失败截图.png";
      await K.shoot(page, shot, { fullPage: true, logger: L });
      const d = await K.diagnose(page, {});
      L.log("诊断 url=" + d.url + " title=" + d.info.title + " bodyLen=" + d.dom.bodyLen);
    } catch (e2) {
      L.log("取证失败 " + String(e2).slice(0, 100));
    }
  }
} finally {
  // 7. 结果写回日志旁（Python 侧读日志判断，不依赖 stdout）
  try {
    const rp = LOG.replace(/\.log$/i, "") + "_结果.json";
    fs.writeFileSync(rp, JSON.stringify(result, null, 2), "utf8");
    L.log("结果写入 " + rp);
  } catch (e) {
    L.log("结果写入失败 " + String(e).slice(0, 100));
  }

  if (task) {
    const fin = await K.finish(task, []);
    L.log("finish " + JSON.stringify(fin).slice(0, 150));
  }

  L.log("总耗时 " + L.elapsed() + "s" + (result.ok ? "" : "（失败）"));
}
