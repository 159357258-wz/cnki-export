/**
 * 导出知网文献为 xls（走导出页 URL，不点 hover 菜单）
 *
 * ⚠️ 本脚本不读环境变量（ego-browser 的 nodejs 子进程不继承父进程 env）。
 *    由 Python 侧替换占位符后传入：
 *      __CNKI_FILENAMES__  已带库代码前缀的 filename 串（CJFQ!xxx,CJFQ!yyy,...）
 *      __CNKI_DL_DIR__     下载目录（用于核对新文件）
 *
 * 输出：ego-lite 下载目录里出现 CNKI-<时间戳>.xls
 */

const FN = __CNKI_FILENAMES__;
const DL_DIR = __CNKI_DL_DIR__;
const EXPORT_BASE = "https://kns.cnki.net/dm8/manage/export.html";

const fs = await import("node:fs");

console.log("filename 长度:", FN.length, "｜条数:", FN.split(",").length);
console.log("下载目录:", DL_DIR);

function snapshotDownloads() {
  try {
    return fs.readdirSync(DL_DIR).filter(x => x.toLowerCase().endsWith(".xls"));
  } catch (e) {
    return [];
  }
}
const before = snapshotDownloads();
console.log("导出前 xls 数量:", before.length);

// 打开导出页
const t = await taskSpace("cnki-export");
const p = t.page("p1");
const url = EXPORT_BASE
  + "?filename=" + encodeURIComponent(FN)
  + "&displaymode=selfDefine&uniplatform=NZKPT";
console.log("URL 长度:", url.length);

try {
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
} catch (e) {
  console.log("goto 提示:", String(e).slice(0, 100));
}
await new Promise(r => setTimeout(r, 6000));

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
  console.log("❗ 找不到 xls 按钮 —— 登录态可能失效");
  throw new Error("no xls button");
}

// 全选字段
const sel = await p.evaluate(() => {
  const e = Array.from(document.querySelectorAll("a, span"))
    .find(x => x.textContent.trim() === "全选");
  if (e) { e.click(); return "clicked"; }
  return "not found";
});
console.log("全选字段:", sel);
await new Promise(r => setTimeout(r, 1500));

// 点 xls
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
  console.log("坐标点击失败，改元素点击:", r);
}

// 等下载
console.log("等待下载...");
let added = [];
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const after = snapshotDownloads();
  added = after.filter(x => before.indexOf(x) < 0);
  if (added.length > 0) break;
}

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
  console.log("NEWFILE:" + added[0]);
} else {
  console.log("⚠️ 没找到新文件");
}

console.log("DONE");
