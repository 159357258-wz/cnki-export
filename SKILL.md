---
name: cnki-export
description: 从中国知网（CNKI）批量导出某期刊某年份的全部论文题录与摘要为 xls/CSV。当用户说「导出知网某期刊某年的论文」「知网批量导出摘要」「导 XX 期刊 20XX 年的文章」时使用。基于 ego-lite（或任何能拿到 data-filename 的浏览器自动化），需要真实的机构登录态。核心是绕过知网「导出与分析」那个点不到的 CSS hover 菜单——直接构造导出页 URL。
whenToUse: 用户需要从知网按「期刊 + 年份」批量获取论文题录（题名/作者/摘要/关键词/期/页码/DOI）时。典型触发语：「知网导出」「批量导出摘要」「把《价格理论与实践》2020 年的论文导出来」「导某刊某年的文章清单」。
metadata:
  version: "1.0.0"
  verified: "2026-10-23 实测通过：《价格理论与实践》2020 年 560 条全部导出，摘要 560/560 非空"
  platform: "Windows（ego-lite）；macOS/Linux 未测"
---

# 知网批量导出（按期刊 + 年份）

## 这个 skill 解决什么

**知网的「导出与分析 → 导出文献 → 自定义」是一个纯 CSS `:hover` 下拉菜单。用自动化工具时，`a[exporttype="selfDefine"]` 元素的 `getBoundingClientRect()` 永远是 `[0,0,0,0]`——它不在 layout 树里，任何 `element.click()`、jQuery `.trigger('click')`、强制 `display:block` 都点不到。**

**本 skill 的做法：不点菜单，直接构造导出页 URL。**

## 前置条件（三条，缺一不可）

**⭐ 一、浏览器有真实机构登录态**

**知网导出需要机构权限。先在浏览器里完成「机构登录」，确认页面顶部显示你所在单位名称（如「湖北汽车工业学院」）。**

**⭐⭐ 二、浏览器能拿到 `a[data-filename]`**

**知网检索结果每行的题名链接带两个属性：**

```html
<a data-filename="JGLS202012014" data-dbname="CJFQ" data-resource="JOURNAL">题名</a>
```

- `data-filename`：文章编号（刊名代码 + 年 + 期 + 序号）
- `data-dbname`：数据库代码（学术期刊通常是 `CJFQ`）

**⭐⭐★ 三、浏览器是非管理员权限运行**

**如果用 ego-lite：它拒绝在 elevated（管理员）进程下运行，报错原文：**

```
ego-browser is elevated and its medium-integrity relay failed.
Run the same command from a non-elevated terminal.
```

**Windows 内置 Administrator 账户（`FilterAdministratorToken=0`）会让所有进程强制 High 完整性，即使改注册表也为难 —— 实测无效。必须用「普通管理员账户 + UAC 开启」或标准用户。**

## 流程（五步）

### 第 1 步：专业检索

**打开：**

```
https://kns.cnki.net/kns8s/AdvSearch?type=expert
```

**在 `textarea.textarea-major` 里输入检索式：**

```
LY='期刊名' AND YE=年份
```

**例：**

```
LY='价格理论与实践' AND YE=2020
```

**然后点 `input.btn-search`。**

**⭐ 字段代码见 `references/cnki-search-syntax.md`。**

### 第 2 步：收集全部 filename

**检索结果每页 20 条。逐页读 `a[data-filename]` + `a[data-dbname]`，点 `#PageNext` 翻页。**

## 公共模块 `scripts/ego_kit.js`

**三个脚本共用这个模块，不要再各写一遍 `goto` / `evaluate` 样板。**

**24 个导出函数，覆盖从开页面到收尾的全流程：**

```
开空间      openSpace / listSpace / finish / handOff
检索        gotoExpert / readInstitution / fillQuery / submitSearch / readHitInfo
滑块        checkCaptcha / assertNoCaptcha（三判据，不看 DOM 类名）
读结果      readRows
翻页        gotoNextPage
导出        buildExportUrl / openExportPage / selectAllFields / selectAll /
            downloadXls / waitForNewFile / snapshotDir
诊断        shoot / diagnose / cdpProbe / makeLogger
```

**用到的 ego API（22 个）：**

```
page.cdp / click / evaluate / fetch / fill / goto / info / mouse /
screenshot / snapshot / url / waitForEvent / waitForFunction / waitForSelector
task.cdp / finish / handOff / newPage / page / pages / spaceId / tabs
```

**导入方式（ego 脚本走 stdin，没有相对路径基准，必须用绝对 `file:///`）：**

```javascript
const K = await import("file:///F:/工具/_外部技能库/cnki-export/scripts/ego_kit.js");
```

**⭐ 三个性能关键点（都是实测踩出来的）：**

1. **翻页用 `evaluate` 里 `el.click()`，不要用 `page.click()`**——后者是 CDP 原生点击（滚动 + 算坐标 + 真实鼠标），实测每页慢 4 倍（5.2s vs 0.6—1.0s），28 页多花 80 秒。
2. **等待用 `page.waitForFunction`（`polling: 100`），不要 `setTimeout` 轮询**——旧版 40 次 × 300ms，现在一步到位。
3. **收尾用 `finish({keep: []})`，不要 `finish({keep: ["p1"]})`**——保留页面会把空间变成 `ownership: "user"`，下次同名 `taskSpace()` 直接报错 `A task space named "..." already exists and belongs to the user`，且 `takeOverTaskSpace` 需要用户批准，无法自动恢复。空间名建议带时间戳。
4. **导出页必须等「字段区」渲染完再点全选**——只等 `#litoexcel` 时正文可能只有 618 字，字段区还没出来，`checkAllFields()` 找不到 `div.check-labels`，等于没勾，导出只有 5 列、没有摘要。

---

**脚本：`scripts/cnki_collect_filenames.js`**

**⭐ 关键：`#PageNext` 是真正的下一页按钮。不要点 `a.adbutnext-btn`（那是广告）。**

### 第 3 步：分批构造导出页 URL

**知网勾选上限 500 条。超过弹窗：**

```
不能超过500个,若要重新选择,请按清除按钮,再进行选取操作
```

**所以按 500 一批切分。**

**URL 格式：**

```
https://kns.cnki.net/dm8/manage/export.html
  ?filename=<库代码!文件名,库代码!文件名,...>
  &displaymode=selfDefine
  &uniplatform=NZKPT
```

**⭐ 三个必须注意的点：**

```
① 必须带「库代码!」前缀（CJFQ!JGLS202012014），否则返回「暂无数据」
② 多个文件名用英文逗号分隔
③ 整个 filename 参数要 URL 编码
```

**⭐⭐ 第 1 批 500 个文件名约 9500 字符，URL 约 11000 字符 —— 实测浏览器能接受，但已接近上限。超过就再切小。**

### 第 4 步：在导出页点「xls」

**导出页加载后：**

```
① 点「全选」（全选字段，确保含 Summary-摘要）
② 点「xls」（`page.click("#litoexcel")`）
```

**脚本：`scripts/cnki_export_batch.js`**

**⭐ 关键：`xls` 不是 `<a href=".xls">`，而是 `<li id="litoexcel" onclick="filetotext('xls')">`，里面套一个 `<a href="javascript:void(0)">`。用 `page.click("#litoexcel")` 一次命中，不需要坐标。**

**⚠️ 踩过的坑：一开始用 `a[href*='.xls']` 找不到元素（`hasXls=false`），只好退回硬坐标 `mouse.click(1003, 237)`——分辨率一变就废。dump DOM 后才发现真实结构是带 `onclick` 的 `<li>`。**

### 第 5 步：找下载文件并合并

**⭐ 下载目录不是 `Downloads`。ego-lite 的下载目录在：**

```
<User Data>\Profile 1\Preferences  → "download":{"default_directory":"..."}
```

**实测在 `G:\ego下载`。**

**⭐⭐ 导出的 `.xls` 是 HTML 表格（文件头是 `<html xmlns:o='urn:schemas-microsoft-com:office:office'...>`），Excel 能打开，pandas 必须用 `read_html` 而不是 `read_excel`。**

**脚本：`scripts/cnki_export.py`（封装全流程）**

## 已知坑（实测记录）

| 坑 | 现象 | 解法 |
|---|---|---|
| 导出菜单点不到 | `selfDefine` 元素 rect 恒为 `[0,0,0,0]` | 不点菜单，构造 URL |
| 导出页「暂无数据」 | URL 的 filename 少了 `CJFQ!` 前缀 | 加库代码前缀 |
| 勾选超过 500 条 | 弹「不能超过500个」 | 按 500 分批 |
| 翻页点错按钮 | 点了 `a.adbutnext-btn`（广告），页面不翻 | 用 `#PageNext` |
| 找不到下载文件 | `Downloads` 里没有 | 读 Preferences 的 `default_directory` |
| `read_excel` 报错 | `Excel file format cannot be determined` | 用 `read_html` |
| 专业检索 textarea 不可见 | 从「高级检索」点 tab 切换，textarea 仍 `display:none` | 直接访问 `AdvSearch?type=expert` |
| ego-browser 拒绝运行 | `is elevated and its medium-integrity relay failed` | 用非管理员进程 |
| **环境变量传不进脚本** | `process.env.CNKI_QUERY` 是 `undefined`，脚本静默用默认值 | **改用模板替换占位符**（`__CNKI_QUERY__`），不要用 env |
| **检索命中数 ≠ 可导出数** | 命中 146 条，只收到 129 条 | **正常现象**：会议记录/视频等条目没有 `data-filename`，无法用导出页 URL 导出，脚本会统计「跳过 N 条」 |

### 两个容易误判的点

**⭐ 一、`process.env` 在 ego-browser 的 nodejs 子进程里读不到**

**实测：Python `subprocess.run(env=...)` 传的环境变量，在 `ego-browser nodejs -e "..."` 的脚本里是 `undefined`。**

**解法：把 JS 写成模板，用 `__PLACEHOLDER__` 占位，Python 读文件后 `.replace()` 再用 `-e` 传入。**

**⭐⭐ 二、「跳过 N 条」不是丢数据**

**知网检索结果里混有会议记录、视频、论坛公告等条目，它们没有 `a[data-filename]`。这些在网页上可以勾选，但导出页 URL 不收。**

**实测《中国工业经济》2020 年：命中 146 条，其中 17 条是「第二届金台青年学者论坛」的会议记录/视频，实际期刊论文 129 条。**

**脚本会输出：**

```
收集完成：可导出 129 条，跳过 17 条非期刊条目
  （跳过的是会议记录/视频等，没有 data-filename，不能用导出页 URL 导出）
```

## 输出字段（18 列）

```
SrcDatabase-来源库  Title-题名  Author-作者  Organ-单位  Source-文献来源
Keyword-关键词  Summary-摘要  PubTime-发表时间  FirstDuty-第一责任人  Fund-基金
Year-年  Volume-卷  Period-期  PageCount-页码  CLC-中图分类号
ISSN-国际标准刊号  URL-网址  DOI-DOI
```

## 数据清洗提醒

**导出的全部条目里，约 14% 不是学术论文。实测《价格理论与实践》2020 年 560 条中：**

| 类型 | 条数 | 判据 |
|---|---|---|
| 学术论文 | 482 | 其他 |
| 书评（广告性） | 47 | 题名含「——评XX出版社《」 |
| 价格指数点评 | 12 | 题名含「价格指数点评」 |
| 刊名/广告 | 9 | 题名等于刊名或含「因为专注物价」 |
| 选题推荐/征稿 | 4 | 题名含「选题推荐」「征稿」 |
| 其他非论文 | 4 | 作者空 + 摘要以 `<正>` 开头 |
| 公告/启事 | 2 | 题名含「评选公告」「启事」 |

**⭐ 通用判据：`作者` 为空，或 `摘要` 以 `<正>` 开头 → 大概率非论文。**

## 自检（每次改版后先跑）

**⭐ 先导 3 条，验证 URL 能出数据：**

```
filename=CJFQ!<某期第一个编号>,CJFQ!<某期第二个编号>
```

**如果返回「暂无数据」，说明 `data-filename` 属性名或 URL 参数变了 —— 先去结果页确认 `a[data-filename]` 还在不在。**

## 换别的期刊

**改检索式里的 `LY='刊名'`。刊名必须与知网「文献来源」字段完全一致。**

**⭐ 查准确刊名：`https://navi.cnki.net/knavi/journals/<代号>/detail`，或直接在专业检索里用 `LY='关键词'` 试。**

**常用刊名代码（实测）：**

```
JGLS = 价格理论与实践
```

## 换别的数据库

**`data-dbname` 决定 `filename` 前缀：**

```
CJFQ = 学术期刊（网络首发）
CJFD = 学术期刊（光盘版）
CDMD = 学位论文
CPFD = 会议论文
```

**⭐ 脚本会自动从 `data-dbname` 读，不需要手写。**

## 开发验证（不要每次都跑全量）

**⭐ 三个快速开关：**

```bash
--check-only                          只查环境 + 检索 1 次，不翻页不导出（约 8 秒）
--reuse-filenames --dry-run           复用上次 filenames.json，跳过收集（约 12 秒）
--max-pages 2 --dry-run               只翻 2 页（约 12 秒）
```

**⭐⭐ 按「改了什么」选：**

| 改了什么 | 用什么 |
|---|---|
| 检测 / 滑块逻辑 | `--check-only` |
| 导出逻辑 | `--reuse-filenames --dry-run` |
| 收集 / 翻页逻辑 | `--max-pages 2 --dry-run` |
| 真跑 | 全量 |

**⭐⭐★ 纯代码改动（如加检查点、改日志格式）不需要跑浏览器 —— 用静态检查就够：**

```bash
python -c "import ast; ast.parse(open('scripts/cnki_export.py', encoding='utf-8').read())"
node --check 拼接后的.mjs
```