/**
 * cnki_collect_filenames.js —— 收集知网某刊某年的全部 data-filename
 *
 * 占位符（由 cnki_export.py 的 js_str 替换为 JS 字面量）：
 *   __CNKI_QUERY__      检索式，如 "LY='价格理论与实践' AND YE=2020"
 *   __CNKI_OUT__        输出 JSON 绝对路径
 *   __CNKI_LOG__        日志绝对路径
 *   __CNKI_MAX_PAGES__  最多翻多少页（数字，不带引号）
 *   __CNKI_SPACE__      ego 任务空间名
 *
 * 相比旧版的改进：
 *   ① 翻页不再 for 循环 × 40 次 × 300ms 轮询，改用 page.waitForFunction(polling:100)
 *   ② 检索不再固定 sleep 12 秒，改用 page.waitForFunction 等结果行出现
 *   ③ 填检索式用 page.fill(clearFirst) + evaluate 回读校验
 *   ④ 失败时 page.screenshot 取证 + page.info/page.url 诊断
 *   ⑤ 收尾用 task.finish 明确保留 p1
 *
 * 用到的 ego API（14 个）：
 *   taskSpace, task.spaceId, task.page, task.pages, task.tabs, task.finish
 *   page.goto, page.waitForSelector, page.waitForFunction, page.click,
 *   page.fill, page.evaluate, page.info, page.screenshot
 */

const K = await import("file:///F:/工具/_外部技能库/cnki-export/scripts/ego_kit.js");
const fs = await import("node:fs");

const QUERY = __CNKI_QUERY__;
const OUT = __CNKI_OUT__;
const LOG = __CNKI_LOG__;
const MAX_PAGES = __CNKI_MAX_PAGES__;
const SPACE = __CNKI_SPACE__;

const L = K.makeLogger(LOG);

L.log("════ 收集开始 ════");
L.log("检索式: " + QUERY);
L.log("最多页数: " + MAX_PAGES);
L.log("ego_kit 已加载（22 个函数）");

let task = null;
let page = null;
const all = [];
let skipped = 0;
let failed = "";

try {
  // 1. 开空间
  const opened = await K.openSpace(SPACE, "p1", L);
  task = opened.task;
  page = opened.page;

  // 2. 列空间（task.pages / task.tabs）
  const space = await K.listSpace(task);
  L.log("空间: pages=" + JSON.stringify(space.pages) + " tabs=" + space.tabs);

  // 3. 打开检索页（goto + waitForSelector + info）
  await K.gotoExpert(page, { logger: L });

  // 4. 滑块检查（evaluate 三判据）
  await K.assertNoCaptcha(page, "检索页");

  // 5. 填检索式（fill + evaluate 回读）
  await K.fillQuery(page, QUERY, { logger: L });

  // 6. 检索并等结果（click + waitForFunction）
  await K.submitSearch(page, { logger: L });

  // 7. 命中信息
  const hit = await K.readHitInfo(page);
  L.log("命中 " + hit.total + " 条 / " + hit.pageCount + " 页");
  if (!hit.total || hit.total === "0") throw new Error("检索无结果");

  // 8. 逐页收集
  let no = 1;
  while (no <= MAX_PAGES) {
    const pg = await K.readRows(page);
    pg.rows.forEach((r) => { r.page = no; });
    all.push(...pg.rows);
    skipped += pg.noFn;

    const prefix = pg.rows.length
      ? [...new Set(pg.rows.map((r) => String(r.f).slice(0, 4)))].join("/")
      : "-";
    L.log("第" + no + "页 rows=" + pg.rows.length + " noFn=" + pg.noFn +
      " cum=" + all.length + " prefix=" + prefix + " @" + L.elapsed() + "s");

    if (pg.rows.length === 0 && pg.noFn === 0) { L.log("空页，结束"); break; }
    // 先判自设上限，再判末页，避免多翻一次无用页（实测多翻一次白费 1.2 秒）
    if (no >= MAX_PAGES) { L.log("已到自设上限 " + MAX_PAGES + " 页，结束"); break; }
    if (no >= hit.pageCount) { L.log("已到末页（" + hit.pageCount + "），结束"); break; }

    const next = await K.gotoNextPage(page, { logger: L });
    if (!next.moved) { L.log("无法继续翻页，结束"); break; }
    no = next.pageNo;
  }

  L.log("收集完成 " + all.length + " 条（跳过 " + skipped + " 条无 filename）");

} catch (e) {
  failed = String(e).slice(0, 300);
  L.log("❌ " + failed);

  if (page) {
    try {
      const shot = OUT.replace(/\.json$/i, "") + "_失败截图.png";
      await K.shoot(page, shot, { fullPage: true, logger: L });
      const d = await K.diagnose(page, { withSnapshot: true });
      L.log("诊断 url=" + d.url + " title=" + d.info.title +
        " rows=" + d.dom.rows + " queryBox=" + d.dom.hasQueryBox);
    } catch (e2) {
      L.log("取证失败 " + String(e2).slice(0, 100));
    }
  }
} finally {
  // 9. 写结果
  try {
    fs.mkdirSync(OUT.substring(0, OUT.lastIndexOf("\\")), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(all, null, 1), "utf8");
    L.log("写入 " + OUT + "（" + all.length + " 条，" +
      Math.round(fs.statSync(OUT).size / 1024) + " KB）");
  } catch (e) {
    L.log("写入失败 " + String(e).slice(0, 200));
  }

  // 10. 收尾
  if (task) {
    const fin = await K.finish(task, []);
    L.log("finish " + JSON.stringify(fin).slice(0, 150));
  }

  L.log("总耗时 " + L.elapsed() + "s" + (failed ? "（失败）" : ""));
}
