# blogMaker

一個 repo、兩個子網域：`kids/`（兒童）與 `tech/`（技術），共用 `themes/shared`，各部署為一個 Cloudflare Pages 專案。

## 指令

```bash
hugo server -s tech --themesDir ../themes   # 本機預覽（kids 同理）
./scripts/check.sh                          # 建置兩站並驗證廣告與安全行為
```

## Cloudflare Pages 設定（兩個專案各一份）

| 欄位 | kids | tech |
|---|---|---|
| Root directory | `/` | `/` |
| Build command | `hugo -s kids --themesDir ../themes --minify` | `hugo -s tech --themesDir ../themes --minify` |
| Build output | `kids/public` | `tech/public` |
| 環境變數 | `HUGO_VERSION=0.169.0` | `HUGO_VERSION=0.169.0` |

Root 必須是 `/`，`functions/_middleware.js` 才會被部署。

## 廣告

在 `<site>/hugo.toml` 填 `params.ads.client` 與 `params.ads.slots`。留空時不載入任何廣告程式。

- `kids` 的 `ageTreatment = "1"` 是 COPPA 兒童待遇標記，不可移除。
- `kids` 刻意沒有 `top` 版位，避免廣告貼近影片造成誤觸。
- 根網域必須放 `ads.txt`（`https://example.com/ads.txt`）。
- 上線初期設 `CSP_REPORT_ONLY=1`，確認沒有違規後再移除。

## 安全不變量

- `markup.goldmark.renderer.unsafe` 保持 `false`。
- `__CSP_NONCE__` 只能出現在 theme 樣板，不可進入文章內容或外部資料。
