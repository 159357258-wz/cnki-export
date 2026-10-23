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
② 点「xls」（真实鼠标坐标，坐标通常约 (1009, 237)）
```

**脚本：`scripts/cnki_export_batch.js`**

**⭐ 关键：`xls` 按钮的 `getBoundingClientRect()` 是可见的，可以用 `page.mouse.click(x, y)` 直接点。**

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
