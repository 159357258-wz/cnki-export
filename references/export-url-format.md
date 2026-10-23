# 导出页 URL 格式

## 为什么要走 URL

**知网的「导出与分析 → 导出文献 → 自定义」是纯 CSS `:hover` 下拉菜单。**

**实测（2026-10-23）：**

```javascript
// 「自定义」元素的坐标永远是 0
document.querySelector('a[exporttype="selfDefine"]').getBoundingClientRect()
// → { x: 0, y: 0, width: 0, height: 0 }
```

**试过五种点击方式，全部无效：**

```
① element.click()                       → 无反应
② jQuery $(el).trigger('click')         → 无反应
③ 强制 display:block/visibility:visible → rect 仍为 0
④ 完整 mouse 事件序列（mouseover→mousedown→mouseup→click）→ 无反应
⑤ Playwright page.mouse.click(x, y)     → 元素无可见区域，点不了
```

**原因：菜单容器 `ul.dropdown-analysis-btns#batchOpsBox` 的祖先链上有 `display:none`，元素不在 layout 树里。**

## 正确做法：直接构造导出页 URL

```
https://kns.cnki.net/dm8/manage/export.html
  ?filename=<库代码!文件名,库代码!文件名,...>
  &displaymode=selfDefine
  &uniplatform=NZKPT
```

## 参数说明

### filename（必须）

**格式：`<库代码>!<文件名>`，多个用英文逗号分隔。**

**例（3 条）：**

```
CJFQ!JGLS202012014,CJFQ!JGLS202012015,CJFQ!JGLS202012016
```

**⭐ 实测对比：**

| filename | 结果 |
|---|---|
| `JGLS202012014` | ❌ 「暂无数据」 |
| `CJFQ!JGLS202012014` | ✅ 正常加载 |

**⭐⭐ 文件名从结果行 `a[data-filename]` 取，库代码从 `a[data-dbname]` 取。**

### displaymode（必须）

**固定 `selfDefine` —— 对应「自定义」格式（可选字段，含摘要）。**

**其他可用值：**

```
GBTREFER     GB/T 7714-2025 格式引文
REFER        CAJ-CD 格式引文
MLA          MLA 格式引文
APA          APA 格式引文
NEW          查新（引文格式）
newdefine    查新（自定义引文格式）
Refworks     Refworks
EndNote      EndNote
NoteExpress  NoteExpress
NoteFirst    NoteFirst
BibTex       BibTex
selfDefine   自定义 ← 要摘要用这个
elearning    知网研学（原 E-Study）
```

### uniplatform（必须）

**固定 `NZKPT`。**

## 页面结构（导出页加载后）

```
文献导出格式（左侧）
  GB/T 7714-2025 格式引文 / CAJ-CD / MLA / APA / 查新 / Refworks /
  EndNote / NoteExpress / NoteFirst / BibTex / 自定义

已选文献（右侧）
  批量下载  导出  AI文献综述  复制到剪贴板  打印  xls  doc
  排序：发表时间 / 被引频次
  字段列表：SrcDatabase-来源库 Title-题名 Author-作者 Organ-单位
            Source-文献来源 Keyword-关键词 Summary-摘要 ...
  全选  重置  预览
```

**⭐ 关键操作：**

```javascript
// 1. 全选字段（确保含 Summary-摘要）
Array.from(document.querySelectorAll('a, span'))
  .find(e => e.textContent.trim() === '全选').click()

// 2. 点 xls（用真实坐标）
const e = Array.from(document.querySelectorAll('a'))
  .find(x => x.textContent.trim() === 'xls');
const r = e.getBoundingClientRect();
// 实测约 (987, 230, 44, 15) → 点中心 (1009, 237)
```

## 下载文件

**⭐ ego-lite 的下载目录不是 `Downloads`。**

**读取：**

```
<User Data>\Profile 1\Preferences
  → "download": { "default_directory": "G:\\ego下载" }
```

**⭐⭐ 文件命名：`CNKI-<YYYYMMDDHHmmsssss>.xls`**

**⭐⭐★ 文件是 HTML 表格，不是二进制 xls：**

```
文件头：<html xmlns:o='urn:schemas-microsoft-com:office:office'
        xmlns:x='urn:schemas-microsoft-com:office:excel' ...
```

**读法：**

```python
import pandas as pd
dfs = pd.read_html(path, encoding="utf-8")
df = dfs[0]
df.columns = df.iloc[0]      # 第一行是表头
df = df.iloc[1:].reset_index(drop=True)
```

## 长度限制

**⭐ 实测 500 个文件名：**

```
filename 参数长度   约 9,500 字符
完整 URL 长度       约 11,000 字符
```

**浏览器能接受，但已接近上限。**

**⭐⭐ 更多条数（如 1000 条 2 年）建议按 500 一批，分多次导出再合并。**

## 校验清单

**导出后必查：**

```python
# ① 年份是否全部正确
df['Year-年'].unique()           # 应该只有目标年份

# ② 期刊是否全部正确
df['Source-文献来源'].unique()   # 应该只有目标期刊

# ③ 摘要是否非空
(df['Summary-摘要'].astype(str).str.strip() != '').sum()   # 应等于总行数

# ④ 批次间是否重复
df.duplicated(subset=['Title-题名', 'Author-作者', 'Period-期']).sum()   # 应为 0
```
