/**
 * 知网滑块验证检测与等待（被 collect / export 两个脚本共用）
 *
 * ⚠️ 这是个片段，不是独立脚本。由 Python 侧在拼接时插入。
 *
 * 知网滑块的特征（已知）：
 *   ① URL 跳到 kns.cnki.net/verify/home?captchaType=blockPuzzle
 *   ② 页面文本含「滑块」「拖动」「请完成下方验证」「安全验证」
 *   ③ DOM 里有 captcha / verify 相关元素
 *
 * 设计原则：
 *   - 检测到就打印醒目提示，然后「等待」而不是「报错退出」
 *   - 人工拉完滑块，URL 会跳回正常页，脚本自动继续
 *   - 最多等 5 分钟，超时才报错
 */

async function isCaptchaPage(p) {
  try {
    const info = await p.evaluate(() => {
      const url = location.href;
      const txt = document.body ? document.body.innerText : "";
      const hasEl = !!document.querySelector(
        '[class*="captcha"], [id*="captcha"], [class*="verify"], #nc_1_wrapper, .nc-container'
      );
      return { url, txt: txt.slice(0, 800), hasEl };
    });
    const urlBad = /verify|captcha|blockPuzzle/i.test(info.url);
    const txtBad = /滑块|拖动|请完成下方验证|安全验证|验证码/.test(info.txt);
    return {
      is: urlBad || txtBad || info.hasEl,
      url: info.url,
      why: urlBad ? "URL 含 verify/captcha" : (txtBad ? "页面文本含滑块/验证" : (info.hasEl ? "DOM 含 captcha 元素" : ""))
    };
  } catch (e) {
    return { is: false, url: "", why: "" };
  }
}

/**
 * 若检测到滑块，提示人工处理并等待
 * @param p  页面对象
 * @param tag 当前在做什么（用于日志）
 * @param maxWaitMs 最长等待（默认 5 分钟）
 */
async function waitIfCaptcha(p, tag, maxWaitMs) {
  maxWaitMs = maxWaitMs || 300000;
  const chk = await isCaptchaPage(p);
  if (!chk.is) return false;

  console.log("");
  console.log("════════════════════════════════════════════════════════");
  console.log("⚠️  检测到知网滑块验证");
  console.log("    位置：" + tag);
  console.log("    判据：" + chk.why);
  console.log("    URL ：" + chk.url.slice(0, 120));
  console.log("");
  console.log("    👉 请到浏览器窗口里，用鼠标拖动滑块完成验证");
  console.log("       完成后脚本会自动继续，不需要按任何键");
  console.log("       最多等 5 分钟，超时才退出");
  console.log("════════════════════════════════════════════════════════");
  console.log("");

  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));
    const now = await isCaptchaPage(p);
    if (!now.is) {
      const sec = Math.round((Date.now() - t0) / 1000);
      console.log("✅ 滑块已通过（等了 " + sec + " 秒），继续执行");
      // 通过后多等 2 秒，让页面加载
      await new Promise(r => setTimeout(r, 2000));
      return true;
    }
    const sec = Math.round((Date.now() - t0) / 1000);
    if (sec - lastLog >= 15) {
      console.log("   仍在等待滑块... 已等 " + sec + " 秒");
      lastLog = sec;
    }
  }

  throw new Error("滑块验证超时（5 分钟未完成）—— 请重跑，先手动把浏览器里的验证过掉");
}

/**
 * 带滑块检测的 goto
 */
async function gotoWithCaptchaCheck(p, url, tag) {
  try {
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (e) {
    console.log("goto 提示:", String(e).slice(0, 100));
  }
  await new Promise(r => setTimeout(r, 4000));
  await waitIfCaptcha(p, tag || url);
}
