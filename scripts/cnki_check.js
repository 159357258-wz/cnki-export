/**
 * cnki_check.js —— 知网环境自检（不翻页、不导出，约 8—20 秒）
 *
 * 检查六件事：
 *   ① 专业检索页能否打开（page.goto + page.waitForSelector）
 *   ② 是否弹滑块（page.evaluate 三判据，不看 DOM 类名）
 *   ③ 机构登录态是否生效（页面顶部单位名）
 *   ④ 检索式能否命中（page.click + page.waitForFunction）
 *   ⑤ 第 1 页能否读到 data-filename（page.evaluate）
 *   ⑥ 失败时截图 + 诊断（page.screenshot + page.info）
 *
 * 占位符（由 cnki_export.py 替换）：
 *   __CNKI_QUERY__   自检用的检索式
 *   __CNKI_LOG__     日志绝对路径
 *   __CNKI_SPACE__   ego 任务空间名
 *
 * 用到的 ego API（9 个）：
 *   taskSpace, task.spaceId, task.page, task.finish
 *   page.goto, page.waitForSelector, page.waitForFunction, page.click,
 *   page.fill, page.evaluate, page.info, page.screenshot
 */

const K = await import("file:///F:/工具/_外部技能库/cnki-export/scripts/ego_kit.js");
const fs = await import("node:fs");

const QUERY = __CNKI_QUERY__;
const LOG = __CNKI_LOG__;
const SPACE = __CNKI_SPACE__;

const L = K.makeLogger(LOG);

L.log("════ 自检开始 ════");
L.log("检索式 " + QUERY);

const checks = [];
function add(name, ok, detail) {
  checks.push({ name, ok, detail });
  L.log((ok ? "✅ " : "❌ ") + name + "｜" + detail);
}

let task = null;
let page = null;

try {
  const opened = await K.openSpace(SPACE, "p1", L);
  task = opened.task;
  page = opened.page;
  add("任务空间", true, "id=" + task.spaceId + " page=" + page.label);

  // ① 打开检索页
  let info = null;
  try {
    info = await K.gotoExpert(page, { logger: L });
    add("检索页打开", true, "title=" + info.title);
  } catch (e) {
    add("检索页打开", false, String(e).slice(0, 120));
    throw e;
  }

  // ② 滑块
  const cap = await K.checkCaptcha(page);
  add("无滑块", !cap.blocked,
    "urlIsVerify=" + cap.urlIsVerify + " titleIsCaptcha=" + cap.titleIsCaptcha +
    " bodyIsCaptcha=" + cap.bodyIsCaptcha);
  if (cap.blocked) throw new Error("滑块拦截，请在 ego 里手动完成");

  // ③ 机构登录态（用 kit 的 readInstitution，内部等过顶栏渲染）
  const inst = await K.readInstitution(page);
  add("机构登录", !!inst, inst || "未识别到单位名（若检索能命中，通常说明登录态在）");

  // ④ 检索
  await K.fillQuery(page, QUERY, { logger: L });
  const ms = await K.submitSearch(page, { logger: L });
  const hit = await K.readHitInfo(page);
  add("检索命中", !!hit.total && hit.total !== "0",
    hit.total + " 条 / " + hit.pageCount + " 页（耗时 " + (ms / 1000).toFixed(1) + "s）");
  if (!hit.total || hit.total === "0") throw new Error("检索无结果");

  // ⑤ 读第一页
  const pg = await K.readRows(page);
  const withFn = pg.rows.filter((r) => r.f).length;
  add("读到 data-filename", withFn > 0,
    withFn + " 条有 filename，" + pg.noFn + " 条无（会议/视频类正常无）");

  // ⑥ 诊断信息
  const d = await K.diagnose(page, {});
  L.log("诊断 url=" + d.url + " rows=" + d.dom.rows + " bodyLen=" + d.dom.bodyLen);

} catch (e) {
  L.log("❌ 异常 " + String(e).slice(0, 200));
  if (page) {
    try {
      const shot = LOG.replace(/\.log$/i, "") + "_自检失败.png";
      await K.shoot(page, shot, { fullPage: true, logger: L });
    } catch (e2) { /* 忽略 */ }
  }
} finally {
  const okCount = checks.filter((c) => c.ok).length;
  L.log("────────────────────────────");
  L.log("自检结果: " + okCount + "/" + checks.length + " 项通过");
  const allOk = checks.length >= 5 && okCount === checks.length;
  L.log(allOk ? "✅ 环境可用" : "⚠️ 有问题，见上");

  // 结果 JSON（Python 侧读它判断）
  try {
    const rp = LOG.replace(/\.log$/i, "") + "_结果.json";
    fs.writeFileSync(rp, JSON.stringify({
      ok: allOk,
      passed: okCount,
      total: checks.length,
      checks,
    }, null, 2), "utf8");
    L.log("结果写入 " + rp);
  } catch (e) { /* 忽略 */ }

  if (task) {
    const fin = await K.finish(task, []);
    L.log("finish " + JSON.stringify(fin).slice(0, 120));
  }

  L.log("总耗时 " + L.elapsed() + "s");
}
