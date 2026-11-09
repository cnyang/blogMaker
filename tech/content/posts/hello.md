---
{
  "id": "tech-hello",
  "title": "範例：用檔案當狀態機",
  "date": "2026-11-06",
  "tags": [
    "架構",
    "Python"
  ],
  "description": "狀態機不一定要資料庫。",
  "publish": false,
  "status": "draft",
  "ai": true,
  "labels": [
    "技術"
  ]
}
---
版面範例，上線前刪除。內文含有 `inline code` 與程式碼區塊。

## 為什麼不用資料庫

> 能用檔案解決，就不要多一個服務。

狀態只有幾種，用檔案就能判斷，還能天然支援續跑。

```python
from pathlib import Path

def status(job: Path) -> str:
    return "done" if (job / "final.mp4").exists() else "running"
```
