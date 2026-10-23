/**
 * 知网环境自检（不翻页、不导出，约 8 秒）
 *
 * 检查四件事：
 *   ① 专业检索页能否打开
 *   ② 机构登录态是否生效（页面顶部是否显示单位名）
 *   ③ 有没有滑块
 *   ④ 检索式能否命中（命中多少条）
 *
 * 占位符由 Python 侧替换：
 *   __CNKI_QUERY__
 *
 * 退出码：
 *   0 = 全部正常
 *   1 = 有问题（会打印原因）
 */

// __CAPTCHA_SNIPPET__

const QUERY = __CNKI_QUERY__;
const EXPERT_URL = "https://kns.cnki.net/kns8s/AdvSearch?type=expert";

const t = await taskSpace("cnki-check");
const p = t.page("p1");

console.log("【检查】检索式:", QUERY);
console.log("");

// ① 打开页面
console.log("① 打开专业检索页");
await gotoWithCaptchaCheck(p, EXPERT_URL, "打开专业检索页");
await new Promise(r => setTimeout(r, 1500));

const taOk = await p.evaluate(() => {
  const ta = document.querySelector("textarea.textarea-major");
  return { has: !!ta, visible: ta ? ta.offsetParent !== null : false };
});
console.log("   textarea 存在:", taOk.has, "｜可见:", taOk.visible);

// ② 登录态
console.log("");
console.log("② 检查机构登录态");
const login = await p.evaluate(() => {
  const txt = document.body.innerText.slice(0, 400);
  // 页头通常显示「<单位名> 个人登录」或「机构登录 个人登录」
  const m = txt.match(/([\u4e00-\u9fa5]{2,20})\s+个人登录/);
  return {
    head: txt.replace(/\s+/g, " ").slice(0, 180),
    unit: m ? m[1] : "",
    hasLoginBtn: /机构登录|个人登录/.test(txt)
  };
});
if (login.unit) {
  console.log("   ✅ 已登录机构:", login.unit);
} else if (login.hasLoginBtn) {
  console.log("   ⚠️ 未检测到机构名（可能未登录，或单位名格式不同）");
  console.log("      页头:", login.head);
} else {
  console.log("   ? 页头里没有登录控件:", login.head);
}

// ③ 滑块
console.log("");
console.log("③ 检查滑块");
const cap = await isCaptchaPage(p);
if (cap.is) {
  console.log("   ⚠️ 当前有滑块 ——", cap.why);
  await waitIfCaptcha(p, "自检时");
  console.log("   ✅ 滑块已过");
} else {
  console.log("   ✅ 没有滑块");
}

// ④ 检索
console.log("");
console.log("④ 试检索");
const setOk = await p.evaluate((q) => {
  const ta = document.querySelector("textarea.textarea-major");
  if (!ta) return "no textarea";
  ta.focus();
  ta.value = q;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  return ta.value;
}, QUERY);
if (setOk !== QUERY) {
  console.log("   ❌ 检索式填不进去:", setOk);
  throw new Error("fill failed");
}
console.log("   已填入:", setOk);

await p.evaluate(() => {
  const b = document.querySelector("input.btn-search");
  if (b) b.click();
});
await new Promise(r => setTimeout(r, 8000));
await waitIfCaptcha(p, "点检索之后");
await new Promise(r => setTimeout(r, 3000));

const res = await p.evaluate(() => {
  const txt = document.body.innerText;
  const m = txt.match(/共找到\s*([\d,]+)\s*条/);
  const pg = txt.match(/(\d+)\/(\d+)/);
  const rows = document.querySelectorAll("table.result-table-list tbody tr").length;
  const withFn = document.querySelectorAll("a[data-filename]").length;
  return {
    total: m ? m[1] : "",
    page: pg ? pg.slice(1).join("/") : "",
    firstPageRows: rows,
    firstPageWithFn: withFn
  };
});
console.log("   命中:", res.total, "条｜页码:", res.page);
console.log("   第 1 页：", res.firstPageRows, "行，其中", res.firstPageWithFn, "条有 data-filename");

if (!res.total || res.total === "0") {
  console.log("");
  console.log("❌ 检索结果为 0 —— 可能原因：");
  console.log("   ① 刊名与知网「文献来源」不完全一致（试 LZ='刊名' 或去知网查准确刊名）");
  console.log("   ② 该年该刊没有收录");
  console.log("   ③ 登录态失效，没有权限");
  throw new Error("no result");
}

console.log("");
console.log("════════════════════════════════════════");
console.log("✅ 自检通过");
console.log("   命中 " + res.total + " 条，第 1 页可导出 " + res.firstPageWithFn + " 条");
console.log("   可以跑全量了");
console.log("════════════════════════════════════════");
