# 知网专业检索语法

## 入口

```
https://kns.cnki.net/kns8s/AdvSearch?type=expert
```

**⭐ 不要从「高级检索」页点 tab 切换 —— 实测切换后 `textarea.textarea-major` 仍然是 `display:none`，写值会被重置。必须直接访问带 `type=expert` 的 URL。**

## 字段代码（2026-10 实测，取自知网页面原文）

```
SU  = 主题
TKA = 篇关摘
KY  = 关键词
TI  = 篇名
FT  = 全文
AU  = 作者
FI  = 第一作者
RP  = 通讯作者
AF  = 作者单位
FU  = 基金
AB  = 摘要
CO  = 小标题
RF  = 参考文献
CLC = 分类号
LY  = 文献来源
DOI = DOI
CF  = 被引频次
```

## 运算符

```
AND  = 并且
OR   = 或者
NOT  = 不含
*    = 并且（同 AND）
+    = 或者（同 OR）
-    = 不含（同 NOT）
%    = 模糊匹配（如 AU % '陈' 匹配姓陈的所有作者）
```

## 常用模板

**⭐ 按期刊 + 年份**

```
LY='价格理论与实践' AND YE=2020
```

**⭐⭐ 按期刊 + 年份 + 主题**

```
LY='价格理论与实践' AND YE=2020 AND SU='数字经济'
```

**⭐⭐★ 按期刊 + 年份区间**

```
LY='价格理论与实践' AND YE>=2018 AND YE<=2022
```

**⭐⭐⭐⭐ 按篇名关键词 + 期刊**

```
TI='价格' AND LY='价格理论与实践'
```

## 年份字段

**`YE` 没有出现在页面列出的「可检索字段」里，但实测可用。**

**⭐ 如果 `YE` 失效，改用页面上的「时间范围 → 发表时间」下拉。**

## 检索结果页的关键选择器

```css
table.result-table-list tbody tr      /* 结果行 */
td.seq input.cbItem                   /* 勾选框 */
td.name a                             /* 题名链接 */
a[data-filename]                      /* 文章编号（关键） */
a[data-dbname]                        /* 数据库代码 */
#PageNext                             /* 下一页（真正的） */
a.adbutnext-btn                       /* ⚠️ 广告按钮，别点 */
```

## 结果总数与分页

**页面文本里有：**

```
共找到 560 条结果 1/28
```

**⭐ 每页固定 20 条。560 条 = 28 页。**

## 勾选机制

**行勾选框是原生 checkbox，可以批量点：**

```javascript
document.querySelectorAll('input.cbItem').forEach(cb => { if (!cb.checked) cb.click(); });
```

**⭐ 跨页选择是累计的 —— 勾完第 1 页翻到第 2 页，「已选」仍是 20。**

**⭐⭐ 但上限 500 条。超过弹：`不能超过500个,若要重新选择,请按清除按钮,再进行选取操作`**

**⭐⭐★ 判断已选数量：页面文本里 `已选 (\d+)`。**
