/**
 * 知网环境自检（不翻页、不导出，约 8—20 秒）
 *
 * 检查四件事：
 *   ① 专业检索页能否打开
 *   ② 机构登录态是否生效（页面顶部是否显示单位名）
 *   ③ 检索式能否命中（命中多少条）
 *   ④ 第 1 页能否读到 data-filename
 *
 * 占位符由 Python 侧替换：__CNKI_QUERY__
 */

const fs = await import("node:fs");
const LOG = "C:\\ego_test\\check.log";
function log(m) {
  try { fs.appendFileSync(LOG, m + "\n", "utf8"); } catch (e) {}
  console.log(m);
}
try { fs.writeFileSync(LOG, "", "utf8"); } catch (e) {}

const QUERY = __CNKI_QUERY__;
const EXPERT_URL = "https://kns.cnki.net/kns8s/AdvSearch?type=expert";

log("检索式: " + QUERY);

const t = await taskSpace("cnki-check");
const p = t.page("p1");

try {
  await p.goto(EXPERT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
} catch (e) {
  log("goto 提示: " + String(e).slice(0, 100));
}
await new Promise(r => setTimeout(r, 4000));

const taOk = await p.evaluate(() => {
  const ta = document.querySelector("textarea.textarea-major");
  return { has: !!ta, visible: ta ? ta.offsetParent !== null : false };
});
log("① textarea 存在=" + taOk.has + " 可见=" + taOk.visible);

const login = await p.evaluate(() => {
  const txt = document.body.innerText.slice(0, 400);
  const m = txt.match(/([\u4e00-\u9fa5]{2,20})\s+个人登录/);
  return { unit: m ? m[1] : "", hasBtn: /机构登录|个人登录/.test(txt) };
});
if (login.unit) {
  log("② 已登录机构: " + login.unit);
} else {
  log("② 未检测到机构名（可能未登录）");
}

const setOk = await p.evaluate((q) => {
  const ta = document.querySelector("textarea.textarea-major");
  if (!ta) return "NO_TA";
  ta.focus();
  ta.value = q;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return ta.value;
}, QUERY);
log("③ 已填入: " + setOk);

await p.evaluate(() => {
  const b = document.querySelector("input.btn-search");
  if (b) b.click();
});
await new Promise(r => setTimeout(r, 12000));

const res = await p.evaluate(() => {
  const txt = document.body.innerText;
  const m = txt.match(/共找到\s*([\d,]+)\s*条/);
  const pg = txt.match(/(\d+)\/(\d+)/);
  const rows = document.querySelectorAll("table.result-table-list tbody tr").length;
  const withFn = document.querySelectorAll("a[data-filename]").length;
  return {
    total: m ? m[1] : "",
    page: pg ? pg.slice(1).join("/") : "",
    rows: rows,
    withFn: withFn
  };
});
log("④ 命中 " + res.total + " 条 | 页码 " + res.page
  + " | 第1页 " + res.rows + " 行，其中 " + res.withFn + " 条有 data-filename");

if (!res.total || res.total === "0") {
  log("❌ 检索结果为 0 —— 检查刊名是否与知网「文献来源」完全一致");
  throw new Error("no result");
}
log("✅ 自检通过");
