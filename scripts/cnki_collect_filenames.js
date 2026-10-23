/**
 * 收集知网检索结果的全部 data-filename
 *
 * 用法（ego-browser）：
 *   set CNKI_QUERY=LY='价格理论与实践' AND YE=2020
 *   set CNKI_OUT=F:\path\to\filenames.json
 *   ego-browser nodejs < cnki_collect_filenames.js
 *
 * 或者从 Python 调用（见 cnki_export.py）。
 *
 * 输出 JSON：
 *   [{ "f": "JGLS202012014", "db": "CJFQ", "title": "...", "page": 1 }, ...]
 */

const QUERY = process.env.CNKI_QUERY || "LY='价格理论与实践' AND YE=2020";
const OUT = process.env.CNKI_OUT || "cnki_filenames.json";
const EXPERT_URL = "https://kns.cnki.net/kns8s/AdvSearch?type=expert";
const MAX_PAGES = parseInt(process.env.CNKI_MAX_PAGES || "60", 10);

const t = await taskSpace("cnki-collect");
const p = t.page("p1");

console.log("检索式:", QUERY);

// 1. 打开专业检索页
try {
  await p.goto(EXPERT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
} catch (e) {
  console.log("goto 提示:", String(e).slice(0, 100));
}
await new Promise(r => setTimeout(r, 5000));

// 2. 检查登录态
const loginOk = await p.evaluate(() => {
  const txt = document.body.innerText;
  const m = txt.match(/个人登录|机构登录/);
  return { hasLoginBtn: !!m, head: txt.slice(0, 200).replace(/\s+/g, " ") };
});
console.log("页面头部:", loginOk.head.slice(0, 120));

// 3. 输入检索式
const setOk = await p.evaluate((q) => {
  const ta = document.querySelector("textarea.textarea-major");
  if (!ta) return "找不到 textarea.textarea-major";
  ta.focus();
  ta.value = q;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  return ta.value;
}, QUERY);
console.log("已填入:", setOk);

if (setOk !== QUERY) {
  console.log("❗ 检索式没填进去，检查 textarea 是否可见");
  throw new Error("fill failed");
}

// 4. 检索
await p.evaluate(() => {
  const b = document.querySelector("input.btn-search");
  if (b) b.click();
});
await new Promise(r => setTimeout(r, 12000));

// 5. 读总数与页码
const head = await p.evaluate(() => {
  const txt = document.body.innerText;
  return {
    total: (txt.match(/共找到\s*([\d,]+)\s*条/) || [])[1],
    page: (txt.match(/(\d+)\/(\d+)/) || []).slice(1).join("/")
  };
});
console.log("检索结果:", JSON.stringify(head));

if (!head.total) {
  console.log("❗ 没有检索到结果，检查检索式或登录态");
  throw new Error("no result");
}

// 6. 逐页收集
const all = [];
let pageNo = 1;

while (pageNo <= MAX_PAGES) {
  const rows = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll("table.result-table-list tbody tr").forEach(tr => {
      const a = tr.querySelector("a[data-filename]");
      const ta = tr.querySelector("td.name a");
      if (a) {
        out.push({
          f: a.getAttribute("data-filename"),
          db: a.getAttribute("data-dbname") || "CJFQ",
          title: ta ? (ta.textContent || "").trim() : ""
        });
      }
    });
    return out;
  });

  rows.forEach(r => { r.page = pageNo; });
  all.push(...rows);

  if (pageNo % 5 === 0 || pageNo === 1) {
    console.log("  第 " + pageNo + " 页，本页 " + rows.length + " 条，累计 " + all.length);
  }

  // 翻页
  const moved = await p.evaluate(() => {
    const n = document.querySelector("#PageNext");
    if (!n) return false;
    const cls = n.className || "";
    if (cls.indexOf("disabled") >= 0) return false;
    n.click();
    return true;
  });

  if (!moved || rows.length === 0) break;
  pageNo++;
  await new Promise(r => setTimeout(r, 2200));
}

console.log("收集完成，共 " + all.length + " 条");
if (all.length > 0) {
  console.log("  首条:", all[0].f, all[0].db, all[0].title.slice(0, 30));
  console.log("  末条:", all[all.length - 1].f, all[all.length - 1].db);
}

// 7. 写文件
const fs = await import("node:fs");
const path = await import("node:path");
const dir = path.dirname(OUT);
if (dir && dir !== ".") {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}
fs.writeFileSync(OUT, JSON.stringify(all, null, 1), "utf8");
console.log("已写入:", OUT);
