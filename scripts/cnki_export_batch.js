/**
 * 导出知网文献为 xls（走导出页 URL，不点 hover 菜单）
 *
 * 用法（ego-browser）：
 *   set CNKI_FILENAMES_FILE=F:\path\to\batch2.txt   （一行：CJFQ!xxx,CJFQ!yyy,...）
 *   set CNKI_DL_DIR=G:\ego下载                       （下载目录，用于核对）
 *   ego-browser nodejs < cnki_export_batch.js
 *
 * 输出：ego-lite 下载目录里出现 CNKI-<时间戳>.xls
 */

const FNAMES_FILE = process.env.CNKI_FILENAMES_FILE;
const DL_DIR = process.env.CNKI_DL_DIR || "";
const EXPORT_BASE = "https://kns.cnki.net/dm8/manage/export.html";

if (!FNAMES_FILE) {
  console.log("❗ 需要设置 CNKI_FILENAMES_FILE");
  throw new Error("missing CNKI_FILENAMES_FILE");
}

const fs = await import("node:fs");

// 1. 读 filename 列表（已经带 CJFQ! 前缀，逗号分隔）
let fn = fs.readFileSync(FNAMES_FILE, "utf8").trim();
// 容忍 JSON 数组格式
if (fn.startsWith("[")) {
  const arr = JSON.parse(fn);
  fn = arr.map(d => (d.db || "CJFQ") + "!" + d.f).join(",");
}
console.log("filename 长度:", fn.length, "｜条数:", fn.split(",").length);

// 2. 记录导出前下载目录的文件（用于找出新文件）
function snapshotDownloads() {
  if (!DL_DIR) return [];
  try {
    return fs.readdirSync(DL_DIR).filter(x => x.toLowerCase().endsWith(".xls"));
  } catch (e) {
    return [];
  }
}
const before = snapshotDownloads();
console.log("导出前 xls 数量:", before.length);

// 3. 打开导出页
const t = await taskSpace("cnki-export");
const p = t.page("p1");
const url = EXPORT_BASE
  + "?filename=" + encodeURIComponent(fn)
  + "&displaymode=selfDefine&uniplatform=NZKPT";
console.log("URL 长度:", url.length);

try {
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
} catch (e) {
  console.log("goto 提示:", String(e).slice(0, 100));
}
await new Promise(r => setTimeout(r, 6000));

// 4. 检查页面
const info = await p.evaluate(() => {
  const txt = document.body.innerText;
  return {
    title: document.title,
    noData: txt.includes("暂无数据"),
    len: txt.length,
    hasXls: !!Array.from(document.querySelectorAll("a")).find(x => x.textContent.trim() === "xls")
  };
});
console.log("页面状态:", JSON.stringify(info));

if (info.noData) {
  console.log("❗ 返回「暂无数据」——检查 filename 是否带 CJFQ! 前缀");
  throw new Error("no data");
}

if (!info.hasXls) {
  console.log("❗ 找不到 xls 按钮——可能登录态失效或页面结构变了");
  throw new Error("no xls button");
}

// 5. 点「全选」字段（确保含摘要）
const sel = await p.evaluate(() => {
  const e = Array.from(document.querySelectorAll("a, span"))
    .find(x => x.textContent.trim() === "全选");
  if (e) { e.click(); return "clicked"; }
  return "not found";
});
console.log("全选字段:", sel);
await new Promise(r => setTimeout(r, 1500));

// 6. 点 xls（真实鼠标坐标）
const box = await p.evaluate(() => {
  const e = Array.from(document.querySelectorAll("a"))
    .find(x => x.textContent.trim() === "xls");
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
});
console.log("xls 坐标:", JSON.stringify(box));

if (box && box.w > 0) {
  await p.mouse.click(box.x, box.y);
  console.log("已点 xls");
} else {
  const r = await p.evaluate(() => {
    const e = Array.from(document.querySelectorAll("a, li, span"))
      .find(x => x.textContent.trim() === "xls");
    if (!e) return "no element";
    e.click();
    return "fallback clicked " + e.tagName;
  });
  console.log("坐标点击失败，改用元素点击:", r);
}

// 7. 等待下载
console.log("等待下载...");
await new Promise(r => setTimeout(r, 15000));

// 8. 核对新文件
if (DL_DIR) {
  const after = snapshotDownloads();
  const added = after.filter(x => before.indexOf(x) < 0);
  if (added.length > 0) {
    console.log("✅ 新增文件:");
    added.forEach(f => {
      try {
        const st = fs.statSync(DL_DIR + "\\" + f);
        console.log("   " + f + "  " + Math.round(st.size / 1024) + " KB");
      } catch (e) {
        console.log("   " + f);
      }
    });
  } else {
    console.log("⚠️ 下载目录里没找到新文件，检查 CNKI_DL_DIR 是否正确");
  }
}

console.log("DONE");
