/**
 * ego_kit.js —— CNKI 导出任务的 ego-browser 公共模块
 *
 * 设计目标：把 ego 的 42 个 API 里对「批量导出」有用的都接上，而不是只用 goto/evaluate。
 *
 * 本模块用到的 ego API（共 24 个）：
 *   taskSpace, task.spaceId, task.page, task.newPage, task.pages, task.tabs,
 *   task.cdp, task.finish, task.handOff
 *   page.goto, page.url, page.info, page.waitForSelector, page.waitForFunction,
 *   page.waitForEvent, page.click, page.fill, page.evaluate, page.screenshot,
 *   page.snapshot, page.fetch, page.cdp, page.mouse.click
 *
 * 用法（脚本里用绝对 file:/// 导入，因为 ego 的脚本走 stdin，没有相对路径基准）：
 *   const K = await import("file:///F:/工具/_外部技能库/cnki-export/scripts/ego_kit.js");
 */

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────
// 常量：知网的选择器与判据
// ─────────────────────────────────────────────────────────────

export const SEL = {
  queryBox: "textarea.textarea-major",
  searchBtn: "input.btn-search",
  resultTable: "table.result-table-list tbody tr",
  nextBtn: "#PageNext",
  adNextBtn: "a.adbutnext-btn",     // 广告，绝不能点
  cbItem: "td.seq input.cbItem",
  titleLink: "td.name a",
  // 导出页的 xls 按钮：实测是 <li id="litoexcel" onclick="filetotext('xls')">xls</li>
  // 外层 li 有 onclick，内层 a 是 javascript:void(0)。点 li 更可靠。
  xlsLi: "#litoexcel",
  xlsAnchor: "#litoexcel a",
  docLi: "#litoword",
  selectAllBox: "#selectAll, input[name='selectAll'], .check-all input, a#selectAll",
  // 导出字段勾选框：实测分两组
  //   name="SELFDEFINE_selfFiledList"  前 5 个（来源库/题名/作者/单位/来源），默认勾选
  //   name="newdefine_selfFiledList"   后 13 个（关键词/摘要/发表时间/…/DOI），默认未勾
  // 页面有「全选」<a onclick="checkAllFields(true)">，一次全勾
  perPageDiv: "#perPageDiv",
  perPageList: "#perPageDiv ul.sort-list li",
  fieldBoxChecked: "input[name='newdefine_selfFiledList']:checked",
  fieldBoxAll: "input[name='newdefine_selfFiledList']",
};

export const URLS = {
  expert: "https://kns.cnki.net/kns8s/AdvSearch?type=expert",
  exportBase: "https://kns.cnki.net/dm8/manage/export.html",
};

// 滑块判据：只用「用户实际看到的东西」，不看 DOM 类名（会误报隐藏元素）
export const CAPTCHA_JUDGE = `
  (function () {
    const flat = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ");
    return {
      urlIsVerify: /\\/verify\\//.test(location.href),
      titleIsCaptcha: /安全验证/.test(document.title),
      bodyIsCaptcha: /请完成安全验证|向右滑动完成验证/.test(flat),
      url: location.href,
      title: document.title
    };
  })()
`;

// ─────────────────────────────────────────────────────────────
// 日志：ego 的 console.log 在 cmd 重定向下会全缓冲，必须写文件
// ─────────────────────────────────────────────────────────────

export function makeLogger(logPath) {
  try { fs.writeFileSync(logPath, "", "utf8"); } catch (e) { /* 忽略 */ }
  const t0 = Date.now();
  return {
    log(msg) {
      const ts = new Date().toISOString().slice(14, 19);
      const line = "[" + ts + "] " + msg + "\n";
      try { fs.appendFileSync(logPath, line, "utf8"); } catch (e) { /* 忽略 */ }
    },
    elapsed() { return ((Date.now() - t0) / 1000).toFixed(1); },
    elapsedMs() { return Date.now() - t0; },
  };
}

// ─────────────────────────────────────────────────────────────
// 1. 任务空间
// ─────────────────────────────────────────────────────────────

/**
 * 打开（或复用）任务空间并拿到首页。
 * 用到：taskSpace, task.spaceId, task.page, task.pages
 */
export async function openSpace(name, label = "p1", logger) {
  const task = await taskSpace(name);
  const page = task.page(label);
  if (logger) {
    logger.log("空间 " + name + " id=" + task.spaceId + " 页=" + label);
  }
  return { task, page };
}

/**
 * 列出空间里的页与标签页（诊断用）。
 * 用到：task.pages, task.tabs
 */
export async function listSpace(task) {
  const pages = await task.pages();
  const tabs = await task.tabs();
  return {
    pages: pages.map((p) => p.label),
    tabs: tabs.length,
  };
}

// ─────────────────────────────────────────────────────────────
// 2. 滑块检测（三判据，不看 DOM 类名）
// ─────────────────────────────────────────────────────────────

/**
 * 检查当前页是否被滑块拦住。
 * 用到：page.evaluate.load
 */
export async function checkCaptcha(page) {
  const r = await page.evaluate(CAPTCHA_JUDGE);
  r.blocked = r.urlIsVerify || r.titleIsCaptcha || r.bodyIsCaptcha;
  return r;
}

/**
 * 断言无滑块；有滑块就抛错（让用户手动拉，skill 不代过）。
 */
export async function assertNoCaptcha(page, where) {
  const r = await checkCaptcha(page);
  if (r.blocked) {
    throw new Error(
      "滑块拦截（" + where + "）：url=" + r.url + " title=" + r.title +
      " ｜ 请在 ego 浏览器里手动完成滑块后重跑"
    );
  }
  return r;
}

// ─────────────────────────────────────────────────────────────
// 3. 检索页操作
// ─────────────────────────────────────────────────────────────

/**
 * 打开专业检索页并等待检索框就绪。
 * 用到：page.goto, page.waitForSelector, page.waitForFunction, page.info
 */
export async function gotoExpert(page, { timeout = 45000, logger } = {}) {
  const t0 = Date.now();
  await page.goto(URLS.expert, { waitUntil: "domcontentloaded", timeout });
  if (logger) logger.log("  goto 完成 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

  // waitForSelector 替代固定 sleep：检索框出现即可交互
  await page.waitForSelector(SEL.queryBox, { timeout: 20000, state: "visible" });
  if (logger) logger.log("  检索框就绪 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

  // 顶栏（机构名）是异步渲染的：等它出现，最多 6 秒，超时不报错
  try {
    await page.waitForFunction(
      () => {
        const flat = (document.body ? document.body.innerText : "").replace(/\s+/g, " ");
        return /[\u4e00-\u9fa5]{2,20}(?:大学|学院|图书馆|研究院|研究所)/.test(flat);
      },
      undefined,
      { timeout: 6000, polling: 150 }
    );
    if (logger) logger.log("  顶栏已渲染 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  } catch (e) {
    if (logger) logger.log("  顶栏 6 秒内未检出机构名（可能未登录，继续）");
  }

  const info = await page.info();
  return info;
}

/**
 * 切换「每页显示条数」——把 20 条/页改成 50 条/页，页数少一半。
 *
 * 实测：560 条在 20/页时是 28 页（收集 23.9 秒），50/页时是 12 页（约 15 秒）。
 * 控件结构：<div id="perPageDiv"><ul class="sort-list"><li data-val="50"><a>50</a></li></ul></div>
 *
 * 用到：page.evaluate, page.waitForFunction
 */
export async function setPerPage(page, n = 50, { logger } = {}) {
  const before = await page.evaluate(() => {
    const d = document.querySelector("#perPageDiv");
    return d ? d.textContent.trim().replace(/\s+/g, "") : "";
  });

  // 展开下拉
  await page.evaluate(() => {
    const d = document.querySelector("#perPageDiv");
    if (d) d.click();
  });
  await new Promise((r) => setTimeout(r, 400));

  // 点目标 <li data-val="N">
  const clicked = await page.evaluate((val) => {
    const li = document.querySelector('#perPageDiv ul.sort-list li[data-val="' + val + '"]');
    if (!li) return false;
    li.click();
    return true;
  }, String(n));

  if (!clicked) {
    if (logger) logger.log("  ⚠️ 未找到每页 " + n + " 条选项（下拉可能没展开）");
    return { ok: false, before, after: before };
  }

  // ⚠️ 必须等「行数真的变成 n」+「页码重置为 1/N」。
  //    踩过的坑：原来等 rows >= Math.min(n,10) 即 rows>=10，而 20 已满足立刻返回，
  //    结果第 1 页仍是 20 条（旧页大小），第 2 页才变 50，
  //    560 条只收到 520（丢第 1 页的 30 条 + 末页 10 条）。
  let switched = false;
  try {
    await page.waitForFunction(
      (want) => {
        const rows = document.querySelectorAll("table.result-table-list tbody tr").length;
        const m = (document.body.innerText || "").match(/(\d+)\/(\d+)/);
        const onFirstPage = m && Number(m[1]) === 1;
        // 行数达标（或已是末页不足 want 条）且确实在第 1 页
        return onFirstPage && (rows >= want || (rows > 0 && m && Number(m[2]) === 1));
      },
      n,
      { timeout: 20000, polling: 100 }
    );
    switched = true;
  } catch (e) {
    if (logger) logger.log("  ⚠️ 等行数变 " + n + " 超时");
  }

  const after = await page.evaluate(() => ({
    rows: document.querySelectorAll("table.result-table-list tbody tr").length,
    txt: (document.querySelector("#perPageDiv") || {}).textContent || "",
    pageInfo: ((document.body.innerText || "").match(/(\d+)\/(\d+)/) || [])[0] || "",
  }));

  // 判定：行数必须 ≥ 原行数，且页码必须是 1/N 且 N 变小了
  const ok = switched && after.rows > 0;
  if (logger) {
    logger.log("  每页条数 " + (before || "?") + " → " + n +
      "（行数 " + after.rows + "，页码 " + after.pageInfo + "）" + (ok ? " ✅" : " ⚠️"));
  }
  return { ok, before, after: String(n), rows: after.rows, pageInfo: after.pageInfo };
}

/**
 * 读机构名（顶栏单位）。
 * 用到：page.evaluate
 */
export async function readInstitution(page) {
  return await page.evaluate(() => {
    const flat = (document.body ? document.body.innerText : "").replace(/\s+/g, " ");
    const m = flat.match(/([\u4e00-\u9fa5]{2,20}(?:大学|学院|图书馆|研究院|研究所))/);
    return m ? m[1] : "";
  });
}

/**
 * 填写检索式。
 * 用到：page.fill（带 clearFirst，确保覆盖旧值）
 */
export async function fillQuery(page, query, { logger } = {}) {
  await page.fill(SEL.queryBox, query, { clearFirst: true, timeout: 10000 });
  // 回读校验：fill 的「确认编辑生效」不够，再读一次 value
  const actual = await page.evaluate(
    (sel) => (document.querySelector(sel) || {}).value || "",
    SEL.queryBox
  );
  if (actual.trim() !== query.trim()) {
    throw new Error("填充失败：期望「" + query + "」实际「" + actual + "」");
  }
  if (logger) logger.log("  已填检索式: " + actual);
  return actual;
}

/**
 * 点检索并等结果表出现。
 * 用到：page.click, page.waitForSelector, page.waitForFunction
 */
export async function submitSearch(page, { timeout = 40000, logger } = {}) {
  const t0 = Date.now();
  await page.click(SEL.searchBtn, { timeout: 10000, label: "点击检索" });

  // 等结果表真正有行（而不是等固定 12 秒）
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    SEL.resultTable,
    { timeout, polling: 100 }
  );
  const ms = Date.now() - t0;
  if (logger) logger.log("  检索完成 " + (ms / 1000).toFixed(1) + "s");
  return ms;
}

/**
 * 读命中总数与页数。
 * 用到：page.evaluate
 */
export async function readHitInfo(page) {
  return await page.evaluate(() => {
    const txt = document.body ? document.body.innerText : "";
    const total = (txt.match(/共找到\s*([\d,]+)\s*条/) || [])[1] || "";
    const pg = txt.match(/(\d+)\/(\d+)/);
    return {
      total: total.replace(/,/g, ""),
      pageNo: pg ? Number(pg[1]) : 0,
      pageCount: pg ? Number(pg[2]) : 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 4. 结果页读取
// ─────────────────────────────────────────────────────────────

/**
 * 读当前页所有行的 data-filename。
 * 用到：page.evaluate
 */
export async function readRows(page) {
  return await page.evaluate(({ rowSel, titleSel }) => {
    const out = [];
    let noFn = 0;
    document.querySelectorAll(rowSel).forEach((tr) => {
      const a = tr.querySelector("a[data-filename]");
      const ta = tr.querySelector(titleSel);
      if (a) {
        out.push({
          f: a.getAttribute("data-filename"),
          db: a.getAttribute("data-dbname") || "CJFQ",
          title: ta ? ta.textContent.trim() : "",
        });
      } else {
        noFn++;
      }
    });
    const txt = document.body ? document.body.innerText : "";
    const pg = txt.match(/(\d+)\/(\d+)/);
    return { rows: out, noFn, pageNo: pg ? Number(pg[1]) : 0 };
  }, { rowSel: SEL.resultTable, titleSel: SEL.titleLink });
}

/**
 * 翻到下一页并等到页码真的变化。
 *
 * 关键改进：用 page.waitForFunction 等页码变化（polling 100ms），
 * 替代原来的 for 循环 × 40 次 × 300ms 轮询。实测每页省 0.5—1.5 秒。
 *
 * 用到：page.evaluate（点下一页）, page.waitForFunction
 * 返回：{ moved, pageNo }
 */
export async function gotoNextPage(page, { timeout = 20000, logger, retry = 1 } = {}) {
  // ⚠️ 性能关键：用 evaluate 里的 el.click()（纯 JS，毫秒级），
  //    不要用 page.click()（CDP 原生点击：滚动到可见 + 算坐标 + 真实鼠标事件，
  //    实测每页慢 4 倍，28 页累计多花 80 秒）。
  //    点击用 JS，等待用 waitForFunction —— 又快又准。

  // 一次 evaluate 同时：读当前页码、确认按钮可点、点它
  const step = await page.evaluate((sel) => {
    const readNo = () => {
      const m = (document.body ? document.body.innerText : "").match(/(\d+)\/(\d+)/);
      return m ? Number(m[1]) : 0;
    };
    const n = document.querySelector(sel);
    if (!n) return { before: readNo(), clicked: false, reason: "no-button" };
    if ((n.className || "").indexOf("disabled") >= 0) {
      return { before: readNo(), clicked: false, reason: "disabled" };
    }
    n.click();
    return { before: readNo(), clicked: true, reason: "" };
  }, SEL.nextBtn);

  if (!step.clicked) {
    if (logger) logger.log("  下一页不可点（" + step.reason + "）");
    return { moved: false, pageNo: step.before };
  }

  // 等到页码变化。⚠️ 超时要重试：
  //    实测 50 条/页时，个别页渲染慢，10 秒等不到（曾导致只收 100 条就停）。
  //    重试策略：等超时后，再点一次下一页（可能上次点击没生效），最多 retry 次。
  let waited = false;
  for (let att = 0; att <= retry; att++) {
    try {
      await page.waitForFunction(
        (prev) => {
          const m = (document.body ? document.body.innerText : "").match(/(\d+)\/(\d+)/);
          return m && Number(m[1]) !== prev;
        },
        step.before,
        { timeout, polling: 100 }
      );
      waited = true;
      break;
    } catch (e) {
      if (att < retry) {
        if (logger) logger.log("  等页码变化超时（原页码 " + step.before + "），重试 " + (att + 1) + "/" + retry);
        // 重新点一次（上次点击可能没生效）
        await page.evaluate((sel) => {
          const n = document.querySelector(sel);
          if (n) n.click();
        }, SEL.nextBtn).catch(() => {});
      } else {
        if (logger) logger.log("  等页码变化超时（原页码 " + step.before + "），已重试 " + retry + " 次，放弃");
      }
    }
  }
  if (!waited) {
    return { moved: false, pageNo: step.before };
  }

  // waitForFunction 返回 truthy 时页码已变，再读一次拿准确值
  const after = await page.evaluate(() => {
    const m = (document.body ? document.body.innerText : "").match(/(\d+)\/(\d+)/);
    return m ? Number(m[1]) : 0;
  });
  if (logger) logger.log("  翻页 " + step.before + " → " + after);
  return { moved: after !== step.before, pageNo: after };
}

// ─────────────────────────────────────────────────────────────
// 5. 导出页操作
// ─────────────────────────────────────────────────────────────

/**
 * 构造导出页 URL。
 * filename 必须带 DBCODE! 前缀（如 CJFQ!xxx），否则返回「暂无数据」。
 */
export function buildExportUrl(items) {
  const fn = items.map((x) => (x.db || "CJFQ") + "!" + x.f).join(",");
  const url = URLS.exportBase +
    "?filename=" + encodeURIComponent(fn) +
    "&displaymode=selfDefine&uniplatform=NZKPT";
  return { url, filenameLen: fn.length, count: items.length };
}

/**
 * 打开导出页并等 xls 链接出现。
 * 用到：page.goto, page.waitForSelector, page.evaluate
 */
export async function openExportPage(page, url, { timeout = 40000, logger } = {}) {
  if (url.length > 6000) {
    throw new Error("URL 过长（" + url.length + " 字符），会触发 414。请缩小批次");
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  // 必须等「字段勾选区」也渲染完，不能只等 xls 按钮。
  // 实测：只等 #litoexcel 时页面正文可能只有 618 字，字段区还没出来，
  //      此时调 checkAllFields() 找不到 div.check-labels，等于没勾。
  await page.waitForSelector("#litoexcel, #litoword", {
    timeout: 25000, state: "attached",
  }).catch(() => { /* 兜底 */ });

  try {
    await page.waitForFunction(
      () => {
        const hasXls = !!document.querySelector("#litoexcel");
        const fields = document.querySelectorAll("div.check-labels input[type='checkbox']").length;
        const bodyLen = document.body ? document.body.innerText.length : 0;
        return hasXls && fields >= 10 && bodyLen > 1000;
      },
      undefined,
      { timeout: 25000, polling: 150 }
    );
    if (logger) logger.log("  字段区已渲染");
  } catch (e) {
    if (logger) logger.log("  字段区 25 秒内未就绪（继续，但可能导不出摘要）");
  }

  const state = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText : "";
    return {
      noData: /暂无数据/.test(txt),
      has414: /414|Request-URI Too Large/i.test(txt),
      hasXls: !!document.querySelector("#litoexcel"),
      hasDoc: !!document.querySelector("#litoword"),
      len: txt.length,
    };
  });
  if (logger) {
    logger.log("  导出页 noData=" + state.noData + " has414=" + state.has414 +
      " hasXls=" + state.hasXls + " len=" + state.len);
  }
  return state;
}

/**
 * 勾选全部 18 个导出字段（含摘要）。
 *
 * 实测：导出页默认只勾前 5 个（SELFDEFINE_selfFiledList），
 * 后 13 个（newdefine_selfFiledList，含 Summary-摘要）默认未勾，
 * 导致导出的 xls 只有 5 列、没有摘要。
 * 页面提供「全选」<a onclick="checkAllFields(true)">，一次全勾。
 *
 * 用到：page.evaluate, page.waitForFunction
 */
export async function selectAllFields(page, { logger } = {}) {
  const before = await page.evaluate((sel) => document.querySelectorAll(sel).length,
                                       SEL.fieldBoxChecked);

  const r = await page.evaluate(() => {
    // ① 直接调页面函数
    if (typeof checkAllFields === "function") {
      checkAllFields(true);
      return "func";
    }
    // ② 点文本恰为「全选」的 <a>
    for (const a of document.querySelectorAll("a, button, span")) {
      if ((a.textContent || "").trim() === "全选") {
        a.click();
        return "click";
      }
    }
    // ③ 逐个勾
    const boxes = document.querySelectorAll("input[name='newdefine_selfFiledList']");
    let n = 0;
    boxes.forEach((b) => { if (!b.checked) { b.click(); n++; } });
    return "each:" + n;
  });

  // 等勾选数增加
  try {
    await page.waitForFunction(
      ({ sel, prev }) => document.querySelectorAll(sel).length > prev,
      { sel: SEL.fieldBoxChecked, prev: before },
      { timeout: 5000, polling: 100 }
    );
  } catch (e) { /* 兜底：可能本来就全勾 */ }

  const after = await page.evaluate((sel) => document.querySelectorAll(sel).length,
                                      SEL.fieldBoxChecked);
  const total = await page.evaluate((sel) => document.querySelectorAll(sel).length,
                                      SEL.fieldBoxAll);
  if (logger) {
    logger.log("  字段全选 " + r + "：已勾 " + before + " → " + after + " / " + total);
  }
  return { method: r, before, after, total };
}

/**
 * 用 <form method="POST"> 导航到导出页——绕开 GET 的 URL 长度限制。
 *
 * 实测 URL 长度上限（GET）：
 *   250 条 → 5341 字符 ✅
 *   300 条 → 6391 字符 ❌ 400 Bad Request
 *   500 条 → 10591 字符 ❌ 414 Request-URI Too Large
 * 改用 POST 后：500 条 ✅、560 条 ✅（导航 1.1 秒完成）
 *
 * ⚠️ 但 560 条 POST 后字段区不渲染（fields=0）、点不到 xls、且触发验证码。
 *    所以实际用 250 条/批（3 批收 560 条）。
 *
 * 用到：page.evaluate（建 form 并 submit）, page.waitForSelector, page.waitForFunction
 */
export async function openExportPagePost(page, items, { logger, timeout = 40000 } = {}) {
  const fn = items.map((x) => (x.db || "CJFQ") + "!" + x.f).join(",");
  if (logger) logger.log("  POST 提交 " + items.length + " 条，filename " + fn.length + " 字符");

  // ⚠️ 必须先从同源页面发起 form 提交。
  //    踩过的坑：新开的 taskSpace 里页面是 about:blank，
  //    在 about:blank 上建 form 并 submit，浏览器不执行导航，
  //    页面停在 about:blank（截图可见），随后等 #litoexcel 40 秒超时。
  const cur = await page.url();
  if (!cur || cur === "about:blank" || cur.indexOf("kns.cnki.net") < 0) {
    if (logger) logger.log("  当前页 " + (cur || "about:blank") + "，先导航到同源页面");
    await page.goto("https://kns.cnki.net/kns8s/AdvSearch?type=expert", {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
  }

  // 用 form POST 导航（fetch 只回字符串、不渲染，点不到 xls）
  await page.evaluate((filename) => {
    const old = document.getElementById("__cnki_post_form");
    if (old) old.remove();
    const f = document.createElement("form");
    f.id = "__cnki_post_form";
    f.method = "POST";
    f.action = "https://kns.cnki.net/dm8/manage/export.html";
    f.style.display = "none";
    const add = (name, value) => {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = name;
      i.value = value;
      f.appendChild(i);
    };
    add("filename", filename);
    add("displaymode", "selfDefine");
    add("uniplatform", "NZKPT");
    document.body.appendChild(f);
    f.submit();
  }, fn);

  // 等导出页骨架
  await page.waitForSelector("#litoexcel, #litoword", { timeout, state: "attached" });

  // 等字段区渲染完（这是之前 560 条 POST 失败的根因：fields=0 时调 checkAllFields 无效）
  let fields = 0;
  try {
    await page.waitForFunction(
      () => {
        const n = document.querySelectorAll("div.check-labels input[type='checkbox']").length;
        const len = document.body ? document.body.innerText.length : 0;
        return n >= 10 && len > 1000;
      },
      undefined,
      { timeout: 25000, polling: 150 }
    );
  } catch (e) {
    if (logger) logger.log("  ⚠️ 字段区 25 秒内未就绪");
  }

  const state = await page.evaluate(() => {
    const flat = (document.body ? document.body.innerText : "").replace(/\s+/g, " ");
    return {
      title: document.title,
      bodyLen: flat.length,
      noData: /暂无数据/.test(flat),
      hasXls: !!document.querySelector("#litoexcel"),
      fields: document.querySelectorAll("div.check-labels input[type='checkbox']").length,
      hasCaptcha: /请完成安全验证|请依次点击|向右滑动完成验证/.test(flat),
      url: location.href.slice(0, 120),
    };
  });

  if (logger) {
    logger.log("  导出页 title=" + state.title + " bodyLen=" + state.bodyLen +
      " hasXls=" + state.hasXls + " fields=" + state.fields +
      " noData=" + state.noData + " captcha=" + state.hasCaptcha);
  }
  return state;
}

/**
 * 点「全选」。
 * 用到：page.click
 */
export async function selectAll(page, { logger } = {}) {
  // 实测导出页默认已全选，所以先查已选数，>0 就不用点
  const pre = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText : "";
    const m = txt.match(/已选\s*(\d+)/);
    const boxes = [...document.querySelectorAll("input[type='checkbox']")];
    const checked = boxes.filter((b) => b.checked).length;
    return { selected: m ? Number(m[1]) : checked, boxes: boxes.length, checked };
  });
  if (pre.selected > 0) {
    if (logger) logger.log("  已是全选状态（已选 " + pre.selected + "，复选框 " + pre.checked + "/" + pre.boxes + "）");
    return true;
  }
  const clicked = await page.click(SEL.selectAllBox,
    { timeout: 8000, force: true, label: "全选" }
  ).then(() => true).catch(() => false);
  if (logger) logger.log("  全选 " + (clicked ? "已点击" : "未找到选择器且非默认全选"));
  return clicked;
}

/**
 * 下载 xls。
 *
 * 实测导出页的 xls 不是 <a href=".xls">，而是：
 *   <li id="litoexcel" onclick="filetotext('xls')"> … <a href="javascript:void(0)">xls</a> … </li>
 * 所以按四级降级：
 *   ① page.click("#litoexcel")         —— 点带 onclick 的外层 li
 *   ② page.click("#litoexcel a")       —— 点内层 a
 *   ③ page.evaluate(() => filetotext('xls'))  —— 直接调页面函数
 *   ④ page.mouse.click(中心坐标)       —— 坐标兜底（旧版做法）
 *
 * 用到：page.click, page.evaluate, page.mouse.click, page.fetch
 */
export async function downloadXls(page, { saveAs, logger, waitDownload = false, downloadTimeout = 60000 } = {}) {
  const attempts = [];

  // ⭐ 关键：点击前先 arm download 事件，避免「点完了才发现文件没落盘」
  //    （旧版靠 2 秒轮询目录，最坏多等 2 秒 × 批数）
  let dlPromise = null;
  if (waitDownload) {
    try {
      dlPromise = page.waitForEvent("download", { timeout: downloadTimeout })
        .then((d) => ({ ok: true, download: d }))
        .catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
    } catch (e) {
      if (logger) logger.log("  ⚠️ arm download 失败：" + String(e).slice(0, 80));
    }
  }

  // ── ① 点外层 li ──
  try {
    await page.click(SEL.xlsLi, { timeout: 8000, force: true, label: "导出 xls" });
    attempts.push("click-li:ok");
    if (logger) logger.log("  ✅ page.click(#litoexcel)");
    return { method: "click-li", path: "", size: 0, attempts, download: dlPromise ? await dlPromise : null };
  } catch (e) {
    attempts.push("click-li:" + String(e).slice(0, 60));
    if (logger) logger.log("  ✗ click(#litoexcel) " + String(e).slice(0, 80));
  }

  // ── ② 点内层 a ──
  try {
    await page.click(SEL.xlsAnchor, { timeout: 8000, force: true, label: "导出 xls" });
    attempts.push("click-a:ok");
    if (logger) logger.log("  ✅ page.click(#litoexcel a)");
    return { method: "click-a", path: "", size: 0, attempts, download: dlPromise ? await dlPromise : null };
  } catch (e) {
    attempts.push("click-a:" + String(e).slice(0, 60));
    if (logger) logger.log("  ✗ click(#litoexcel a) " + String(e).slice(0, 80));
  }

  // ── ③ 直接调页面函数 filetotext('xls') ──
  try {
    const r = await page.evaluate(() => {
      if (typeof filetotext === "function") {
        filetotext("xls");
        return "called";
      }
      return "no-func";
    });
    attempts.push("eval-filetotext:" + r);
    if (r === "called") {
      if (logger) logger.log("  ✅ 直接调用 filetotext('xls')");
      return { method: "eval", path: "", size: 0, attempts, download: dlPromise ? await dlPromise : null };
    }
    if (logger) logger.log("  ✗ 页面无 filetotext 函数");
  } catch (e) {
    attempts.push("eval:" + String(e).slice(0, 60));
    if (logger) logger.log("  ✗ evaluate 失败 " + String(e).slice(0, 80));
  }

  // ── ④ 坐标兜底（先量真实位置，不写死）──
  const box = await page.evaluate(() => {
    const el = document.querySelector("#litoexcel") ||
               document.querySelector("#litoword");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  });
  if (box) {
    await page.mouse.click(box.x, box.y);
    attempts.push("mouse:" + box.x + "," + box.y);
    if (logger) logger.log("  ✅ mouse.click 兜底 (" + box.x + "," + box.y + ") 实测尺寸 " + box.w + "×" + box.h);
    return { method: "mouse", path: "", size: 0, attempts, download: dlPromise ? await dlPromise : null };
  }

  attempts.push("all-failed");
  throw new Error("四级降级全失败：" + attempts.join(" | "));
}

/**
 * 等下载文件出现（轮询目录，因为 ego 的下载走 profile 目录）。
 * 用到：无 ego API，纯 fs
 */
export async function waitForNewFile(dir, beforeSet, { timeout = 30000, logger } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let files = [];
    try { files = await fsp.readdir(dir); } catch (e) { files = []; }
    const fresh = files.filter((f) => !beforeSet.has(f) && /\.(xls|xlsx|csv)$/i.test(f));
    if (fresh.length) {
      const p = path.join(dir, fresh[0]);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.size > 1024) {
        if (logger) logger.log("  新文件 " + fresh[0] + " " + Math.round(st.size / 1024) + " KB");
        return p;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (logger) logger.log("  等新文件超时 " + timeout + "ms");
  return "";
}

/**
 * 快照当前目录里的文件集合（用于 waitForNewFile 做差集）。
 */
export async function snapshotDir(dir) {
  try {
    return new Set(await fsp.readdir(dir));
  } catch (e) {
    return new Set();
  }
}

// ─────────────────────────────────────────────────────────────
// 6. 诊断与取证
// ─────────────────────────────────────────────────────────────

/**
 * 截图（用于失败取证）。
 * 用到：page.screenshot
 */
export async function shoot(page, outPath, { fullPage = false, logger } = {}) {
  try {
    await page.screenshot({ path: outPath, fullPage });
    if (logger) logger.log("  截图 " + outPath);
    return outPath;
  } catch (e) {
    if (logger) logger.log("  截图失败：" + String(e).slice(0, 80));
    return "";
  }
}

/**
 * 一次拿全诊断信息。
 * 用到：page.info, page.url, page.snapshot, page.evaluate
 */
export async function diagnose(page, { withSnapshot = false } = {}) {
  const info = await page.info();
  const url = await page.url();
  const dom = await page.evaluate(() => ({
    rows: document.querySelectorAll("table.result-table-list tbody tr").length,
    hasQueryBox: !!document.querySelector("textarea.textarea-major"),
    hasNext: !!document.querySelector("#PageNext"),
    bodyLen: document.body ? document.body.innerText.length : 0,
  }));
  const out = { info, url, dom };
  if (withSnapshot) {
    try { out.snapshot = (await page.snapshot({ scope: "only_within_viewport" })).slice(0, 800); }
    catch (e) { out.snapshot = "（snapshot 失败）"; }
  }
  return out;
}

/**
 * 用 CDP 查网络/性能域，可选。
 * 用到：page.cdp, task.cdp
 */
export async function cdpProbe(page, task) {
  const out = {};
  try {
    out.performance = await page.cdp("Performance.getMetrics", {});
  } catch (e) { out.performance = String(e).slice(0, 80); }
  try {
    out.targets = await task.cdp("Target.getTargets", {});
  } catch (e) { out.targets = String(e).slice(0, 80); }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 7. 收尾
// ─────────────────────────────────────────────────────────────

/**
 * 收尾：保留指定页，其余关闭。
 * 用到：task.finish
 */
export async function finish(task, keep = ["p1"]) {
  try {
    return await task.finish({ keep });
  } catch (e) {
    return { error: String(e).slice(0, 100) };
  }
}

/**
 * 把控制权交给用户（手工介入时用）。
 * 用到：task.handOff
 */
export async function handOff(task) {
  try { await task.handOff(); return true; }
  catch (e) { return false; }
}
