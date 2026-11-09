---
{
  "id": "example-first-post",
  "title": "用 Markdown 管理 Blogger 文章",
  "publish": false,
  "status": "draft",
  "ai": true,
  "labels": ["Markdown", "Blogger"]
}
---

# 用 Markdown 管理 Blogger 文章

把文章放進 Git repo，可以留下每次修改的紀錄，也方便在發布前預覽。

## 寫作流程

1. 建立 Markdown 文章。
2. 由 AI 整理段落，產生摘要與標籤。
3. 將 Markdown 轉成 Blogger 可用的 HTML。
4. 發布或更新同一篇文章。

| 欄位 | 用途 |
| --- | --- |
| `id` | 固定的文章識別碼，重新命名檔案時也保持不變 |
| `publish` | 是否交給 pipeline 同步 |
| `status` | `draft` 草稿或 `published` 公開發布 |

```javascript
console.log('Hello, Blogger!');
```

完整設定請參考 [Blogger API 官方文件](https://developers.google.com/blogger/docs/3.0/using)。
