/**
 * 收集知网检索结果的全部 data-filename（原生版，无滑块检测）
 *
 * 由 Python 侧替换占位符 __CNKI_QUERY__ / __CNKI_OUT__ 后传入。
 *
 * 输出 JSON：
 *   [{ "f": "GGYY202012006", "db": "CJFQ", "title": "...", "page": 1 }, ...]
 */

const QUERY = __CNKI_QUERY__;
const OUT = __CNKI_OUT__;
const EXPERT_URL = "https://kns.cnki.net/kns8s/AdvSearch?type=expert";
const MAX_PAGES = 80;

const t = await taskSpace("cnki-collect");
const p = t.page("p1");

console.log("检索式:", QUERY);
console.log("输出:", OUT);

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
  return { head: txt.slice(0, 220).replace(/\s+/g, " ") };
});
console.log("页面头部:", loginOk.head.slice(0, 140));

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
  console.log("❗ 检索式没填进去");
  throw new Error("fill failed");
}

// 4. 检索
await p.evaluate(() => {
  const b = document.querySelector("input.btn-search");
  if (b) b.click();
});
await new Promise(r => setTimeout(r, 12000));

// 5. 读总数
const head = await p.evaluate(() => {
  const txt = document.body.innerText;
  return {
    total: (txt.match(/共找到\s*([\d,]+)\s*条/) || [])[1],
    page: (txt.match(/(\d+)\/(\d+)/) || []).slice(1).join("/")
  };
});
console.log("检索结果:", JSON.stringify(head));

if (!head.total || head.total === "0") {
  console.log("❗ 没有检索到结果 —— 检查刊名是否与知网「文献来源」完全一致");
  throw new Error("no result");
}

// 6. 逐页收集
const all = [];
let skipped = 0;
let pageNo = 1;

// 读页码指示器（如 "3/28" 的 "3"）—— 比「第一行题名」可靠
async function curPage() {
  return await p.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/(\d+)\/(\d+)/);
    return m ? m[1] : "";
  });
}

while (pageNo <= MAX_PAGES) {
  const page = await p.evaluate(() => {
    const out = [];
    let noFn = 0;
    document.querySelectorAll("table.result-table-list tbody tr").forEach(tr => {
      const a = tr.querySelector("a[data-filename]");
      const ta = tr.querySelector("td.name a");
      if (a) {
        out.push({
          f: a.getAttribute("data-filename"),
          db: a.getAttribute("data-dbname") || "CJFQ",
          title: ta ? (ta.textContent || "").trim() : ""
        });
      } else {
        noFn++;
      }
    });
    return { rows: out, noFn, totalTr: out.length + noFn };
  });

  page.rows.forEach(r => { r.page = pageNo; });
  all.push(...page.rows);
  skipped += page.noFn;

  if (pageNo % 5 === 0 || pageNo === 1 || page.noFn > 0) {
    // 打印本页文件名前缀（前 6 位），用于交叉核对期刊
    const prefix = page.rows.length > 0 ? page.rows.map(r => r.f.slice(0, 4)).filter((v, i, a) => a.indexOf(v) === i).join("/") : "-";
    console.log("  第 " + pageNo + " 页：可导出 " + page.rows.length
      + " 条，跳过 " + page.noFn + " 条，累计 " + all.length + " ｜前缀 " + prefix);
  }

  if (page.totalTr === 0) {
    console.log("  第 " + pageNo + " 页为空，停止");
    break;
  }

  // 翻页：等「页码指示器」变化（比等第一行题名可靠）
  const pBefore = await curPage();
  const moved = await p.evaluate(() => {
    const n = document.querySelector("#PageNext");
    if (!n) return false;
    if ((n.className || "").indexOf("disabled") >= 0) return false;
    n.click();
    return true;
  });
  if (!moved) {
    console.log("  第 " + pageNo + " 页后无法翻页，停止");
    break;
  }

  let changed = false;
  for (let w = 0; w < 60; w++) {
    await new Promise(r => setTimeout(r, 300));
    const pNow = await curPage();
    if (pNow && pNow !== pBefore) { changed = true; break; }
  }
  if (!changed) {
    console.log("  ⚠️ 第 " + (pageNo + 1) + " 页页码未变化（" + pBefore + "），停止以免收错数据");
    break;
  }

  pageNo++;
}

console.log("收集完成：可导出 " + all.length + " 条，跳过 " + skipped + " 条非期刊条目");
if (all.length > 0) {
  console.log("  首条:", all[0].f, all[0].db, all[0].title.slice(0, 30));
}

// 7. 写文件
const fs = await import("node:fs");
const path = await import("node:path");
const dir = path.dirname(OUT);
try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
fs.writeFileSync(OUT, JSON.stringify(all, null, 1), "utf8");
console.log("已写入:", OUT);
