# cnki-export

**从中国知网（CNKI）按「期刊 + 年份」批量导出论文题录与摘要。**

**给别人（或别的 Agent）用：只要你的浏览器里有知网的**机构登录态**，一条命令导完一整年的论文。**

---

## 为什么需要这个

**知网的「导出与分析 → 导出文献 → 自定义」是纯 CSS `:hover` 下拉菜单。**

**自动化工具点它时，`a[exporttype="selfDefine"]` 的 `getBoundingClientRect()` 永远是 `[0,0,0,0]`——元素不在 layout 树里。实测五种点击方式全部无效：**

```
element.click()                       → 无反应
jQuery $(el).trigger('click')         → 无反应
强制 display:block / visibility       → rect 仍为 0
完整 mouse 事件序列                    → 无反应
Playwright page.mouse.click(x, y)     → 无元素可见区域
```

**本项目的解法：不点菜单，直接构造导出页 URL。**

```
https://kns.cnki.net/dm8/manage/export.html
  ?filename=CJFQ!JGLS202012014,CJFQ!JGLS202012015,...
  &displaymode=selfDefine&uniplatform=NZKPT
```

**⭐ 关键：`filename` 必须带「库代码!」前缀，否则返回「暂无数据」。**

---

## 前置条件

**⭐ 一、安装 ego-lite**

**下载：https://lite.ego.app/**

**Windows 首次安装如果窗口黑屏，用 `--disable-gpu` 启动：**

```powershell
egoliteSetup.exe --disable-gpu --disable-software-rasterizer --no-sandbox
```

**⭐⭐ 二、在浏览器里完成知网机构登录**

**打开 https://www.cnki.net/ → 点「机构登录」→ 选你的学校 → 确认页面顶部显示单位名称。**

**⭐⭐★ 三、非管理员进程**

**ego-browser 拒绝在管理员权限下运行：**

```
ego-browser is elevated and its medium-integrity relay failed.
Run the same command from a non-elevated terminal.
```

**Windows 内置 Administrator 账户（`FilterAdministratorToken=0`）会让所有进程强制 High 完整性，改注册表也无效（实测）。必须用「普通管理员账户 + UAC 开启」或标准用户。**

---

## 用法

### 一条命令

```bash
python scripts/cnki_export.py --journal "价格理论与实践" --year 2020 --out F:\data
```

**输出：**

```
F:\data\价格理论与实践_2020_全部560条.csv      原始全量（含类型标记）
F:\data\价格理论与实践_2020_学术论文482条.csv  剔除书评/广告/公告
```

### 先自检（推荐）

```bash
python scripts/cnki_export.py --journal "价格理论与实践" --year 2020 --out F:\data --dry-run
```

**只导 3 条，确认「URL 能出数据」。如果这一步失败，说明知网改了结构或登录态失效——不要直接跑全量。**

### 只想看流程

**看 `SKILL.md`（给 Agent 的说明书）和 `references/`（检索语法、URL 格式细节）。**

---

## 实测记录

**✅ 2026-10-23 验证通过（两个期刊）**

**《价格理论与实践》2020 年：**

```
检索命中：560 条
可导出：560 条（全部是期刊论文）
摘要非空：560/560
两批导出（500 + 60），合并去重后 0 重复
12 期分布：37—42 篇/期（剔除书评广告后）
耗时：约 70 秒
```

**《中国工业经济》2020 年：**

```
检索命中：146 条
可导出：129 条
跳过：17 条（第二届金台青年学者论坛的会议记录/视频，无 data-filename）
摘要非空：129/129
类型分布：学术论文 120、其他非论文 8、选题推荐 1
耗时：41.8 秒
```

**⭐ 「跳过 N 条」不是丢数据 —— 那些条目在网页上能勾选，但没有 `data-filename`，导出页 URL 不收。脚本会把数量报给你。**

**⚠️ 未验证：**

```
① macOS / Linux
② 非 ego-lite 的浏览器（理论可行，但点击 xls 的逻辑要重写）
③ 学位论文库（CDMD）、会议论文库（CPFD）—— 理论上改 dbname 即可，未测
④ 年份区间检索（YE>=2018 AND YE<=2022）—— 语法存在，未实测
```

---

## 输出字段（18 列）

```
来源库  题名  作者  单位  来源  关键词  摘要  发表时间  第一责任人  基金
年  卷  期  页码  中图分类号  ISSN  网址  DOI
```

**⭐ 原始字段名（导出 xls 里的）：**

```
SrcDatabase-来源库  Title-题名  Author-作者  Organ-单位  Source-文献来源
Keyword-关键词  Summary-摘要  PubTime-发表时间  FirstDuty-第一责任人  Fund-基金
Year-年  Volume-卷  Period-期  PageCount-页码  CLC-中图分类号
ISSN-国际标准刊号  URL-网址  DOI-DOI
```

---

## 数据清洗

**导出的全部条目里约 14% 不是学术论文。**

**2020 年《价格理论与实践》560 条实测分布：**

| 类型 | 条数 | 判据 |
|---|---|---|
| 学术论文 | 482 | — |
| 书评（广告性） | 47 | 题名含「——评XX出版社《」 |
| 价格指数点评 | 12 | 题名含「价格指数」+「点评」 |
| 刊名/广告 | 9 | 题名等于刊名，或含「因为专注物价」 |
| 选题推荐/征稿 | 4 | 题名含「选题推荐」「征稿」 |
| 其他非论文 | 4 | 作者为空 + 摘要以 `<正>` 开头 |
| 公告/启事 | 2 | 题名含「评选公告」「启事」 |

**⭐ 通用判据：`作者` 为空，或 `摘要` 以 `<正>` 开头 → 大概率非论文。**

**脚本已内置这个分类，输出两个文件（全量 + 学术论文）。**

---

## 已知坑

| 坑 | 现象 | 解法 |
|---|---|---|
| 导出菜单点不到 | `selfDefine` 元素 rect 恒为 `[0,0,0,0]` | 不点菜单，构造 URL |
| 导出页「暂无数据」 | filename 少了 `CJFQ!` 前缀 | 加库代码前缀 |
| 勾选超 500 条 | 弹「不能超过500个」 | 按 500 分批 |
| 翻页点错按钮 | 点了 `a.adbutnext-btn`（广告），不翻页 | 用 `#PageNext` |
| 找不到下载文件 | `Downloads` 里没有 | 读 `Preferences` 的 `default_directory`（实测 `G:\ego下载`） |
| `read_excel` 报错 | `Excel file format cannot be determined` | 用 `read_html`，文件是 HTML 表格 |
| 专业检索 textarea 不可见 | 从高级检索切 tab，textarea 仍 `display:none` | 直接访问 `?type=expert` |
| ego-browser 拒绝运行 | `is elevated and its medium-integrity relay failed` | 用非管理员进程 |
| 安装窗口黑屏 | 纯黑，无内容 | `--disable-gpu` |
| **环境变量传不进脚本** | `process.env.X` 是 `undefined`，脚本静默用默认值 | **用模板替换占位符**，不要用 env |
| **命中数 ≠ 可导出数** | 命中 146 只收到 129 | **正常**：会议记录/视频无 `data-filename`，脚本会报「跳过 N 条」 |

---

## 换别的期刊

**改 `--journal`，刊名必须与知网「文献来源」字段完全一致。**

**查准确刊名：**

```
https://navi.cnki.net/knavi/journals/<代号>/detail
```

**已知代号：**

```
JGLS = 价格理论与实践
```

---

## 文件结构

```
cnki-export/
├── README.md                        本文件
├── SKILL.md                         给 Agent 的说明书（DSH/Claude 的 skill 格式）
├── references/
│   ├── cnki-search-syntax.md        检索语法与字段代码
│   └── export-url-format.md         导出页 URL 与下载细节
└── scripts/
    ├── cnki_collect_filenames.js    收集 data-filename（ego-browser 脚本）
    ├── cnki_export_batch.js         导出（ego-browser 脚本）
    └── cnki_export.py               全流程封装（参数化）
```

---

## 作为 DSH / Claude Skill 安装

**把本目录放进 skills 目录即可：**

```bash
# DSH
cp -r cnki-export ~/.dsh/skills/

# Claude Code
cp -r cnki-export ~/.claude/skills/
```

**⭐ 或者用 npx（如果 skills CLI 支持）：**

```bash
npx skills add <你的用户名>/cnki-export
```

---

## 许可

**MIT。随便用，但请自己遵守知网的使用条款——不要高频请求，不要绕过验证码。**

**本项目只是把「人工点鼠标的流程」自动化，不破解任何限制。**
