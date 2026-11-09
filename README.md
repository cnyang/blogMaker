# blogMaker

以 Markdown 管理文章，經 AI 潤稿、摘要與標籤整理後，發布到 **Blogger**。保留原本 Hugo 兒童／技術兩站供本機與 GitHub Pages 預覽，共用 `themes/shared`。

```text
posts/ ----------------------+                     +--> Blogger（正式發布）
kids/content/posts/ ---------+--> 驗證 --> AI --> HTML
tech/content/posts/ ---------+                     +--> build/（文章預覽）
         |
         +--> Hugo + themes/shared --> 本機 / GitHub Pages（網站預覽）
```

## 快速開始

需要 Node.js 24 以上、npm、Git；網站預覽與完整檢查另需 Hugo（CI 使用 0.169.0）。

```bash
npm ci
npm test
npm run lint
npm run validate
npm run preview -- --no-ai   # 離線 HTML 預覽，不需憑證、不呼叫 AI 或 Blogger
./scripts/check.sh           # 執行上述檢查，再建置並驗證兩個 Hugo 站
```

`build/<文章 id>.html` 為 Blogger 文章預覽。所有內附範例均為 `publish: false`，不會同步到 Blogger。

## 文章發布 TUI

```bash
npm run tui
```

TUI 會列出 `posts/`、`kids/content/posts/`、`tech/content/posts/` 的文章；可離線閱讀與預覽，發布時使用目前 Markdown，不額外呼叫 AI。上傳前須先完成 [Blogger OAuth 與 Blog ID 設定](docs/blogger.md#設定-blogger-oauth)，設定變更後重新開啟 TUI。

| 按鍵 | 動作 |
|---|---|
| ↑／↓、PgUp／PgDn | 選擇文章；閱讀內容時捲動 |
| Enter | 閱讀選取文章的內容、摘要與標籤 |
| `c` | 切換全部／Tech／兒童／Husky |
| `p` | 產生並開啟單篇 HTML 預覽，不需憑證 |
| `u` | 上傳／更新 Blogger 草稿，按 `y` 確認；不會把已公開文章取消公開 |
| `P`（大寫） | 公開／更新公開文章，輸入完整 `PUBLISH` 後按 Enter 才執行 |
| `r` | 重新讀取文章與本機發布紀錄 |
| Esc／`q` | 返回列表；在列表離開 TUI（確認視窗以 Esc 取消） |
| Ctrl+C | 隨時離開並還原終端機；同步進行中會等它結束，再按一次可立即中止 |

確認畫面會列出文章、來源檔案、目標 Blog ID 與動作。同步只處理這一篇，保留磁碟上的 `publish`／`status`，不會因此啟用後續 CI 同步。若確認後原文已變更，會停止並要求重新整理；處理途中須等待結果才可繼續操作。發布狀態欄為本機最後一次紀錄，操作時才連線核對遠端。

影片文章仍須先在 videoMaker TUI 按 `b` 完成核准與雙平台 hash 驗證、上傳草稿，再由本 TUI 公開該版本。影片播放器是否可公開觀看，要另到影片平台確認。`.blogger/state.json` 與發布鎖沿用 CLI／videoMaker 的機制，請保留；若與 CI 交替管理同一篇文章，先同步紀錄。

## 寫文章

```bash
npm run new -- "技術文章標題" --site tech
npm run new -- "兒童文章標題" --site kids
npm run new -- "只發布到 Blogger 的文章"  # 建立於 posts/
```

`kids/content/posts/` 與 `tech/content/posts/` 的文章共用同一份 Markdown，可同時提供 Blogger 發布與 Hugo 預覽。文章開頭使用 `---` 包住 JSON front matter；保留固定且全域唯一的 `id`。

```markdown
---
{
  "id": "tech-my-first-post",
  "title": "我的第一篇技術文章",
  "date": "2026-11-09",
  "publish": false,
  "status": "draft",
  "ai": true,
  "labels": ["技術"]
}
---

這裡開始撰寫 Markdown 正文。
```

確認內容後，設 `publish: true` 才同步；`status: "draft"` 儲存 Blogger 草稿，`"published"` 才公開。`publish: false` 與刪除本機檔案都不會刪除遠端文章。這些欄位只控制 Blogger，不會隱藏本機 Hugo 預覽。

既有 9 篇 Hugo 範例保留原始路徑與內容，並補上 `kids-`／`tech-` 前綴 ID；原本日期、`tags`、`kind`、`description` 均保留。`tags` 會合併進 Blogger labels。Hugo 隱私權頁不會自動發布到 Blogger。

## Blogger 發布

兒童／Husky 影片文章已接上相鄰 `videoMaker`：影片通過 QC 後由 GX10 自動產出一篇「介紹＋推薦」；Mac 的 videoMaker TUI 按 `p` 匯入預覽、`b` 上傳 Blogger 草稿。匯入檔案在 `posts/video/kids/`／`husky/`，以 `category` 與 labels 分類，包含 YouTube、Facebook 播放器及直接連結。Tech 暫維持手寫流程，影片文章整合見 [設定文件](docs/blogger.md#videomaker-影片文章)。

完整的 [AI、Google OAuth、GitHub Actions 與失敗復原設定](docs/blogger.md)。設定好憑證後：

```bash
npm run preview                     # AI 潤稿與預覽，會使用 OpenAI API
npm run publish -- --dry-run --no-ai  # 離線預覽
npm run publish                     # 同步 publish: true 的文章
```

所有文章目前同步到單一 `BLOGGER_BLOG_ID`，兒童／技術內容以 labels 區分。`--site` 僅決定新文章的位置。

- `.github/workflows/blogger.yml`：PR 執行測試、語法檢查、驗證與離線預覽；設定 `BLOGGER_BLOG_ID` 後，`main` 更新會同步到 Blogger。手動執行預設只產生 AI 預覽。
- `.github/workflows/pages.yml`：保留兩站 GitHub Pages 預覽，帶有 `noindex`，不啟用廣告。
- `blogger-state`：記錄文章 ID、遠端 post ID 與來源雜湊，支援更新、略過未變更文章及失敗復原。請保留這個分支。

Blogger 的佈景主題、隱私權頁、兒童內容設定與 AdSense 需在 Blogger 後台設定；Hugo 的廣告與 CSP 不會套用到 Blogger。此合併不代表已完成 AdSense 申請或審核。

## Hugo 預覽與原有 Cloudflare 設定

```bash
hugo server -s tech --themesDir ../themes
hugo server -s kids --themesDir ../themes
```

若繼續使用原有 Cloudflare Pages 部署，兩站設定如下：

| 欄位 | kids | tech |
|---|---|---|
| Root directory | `/` | `/` |
| Build command | `hugo -s kids --themesDir ../themes --minify` | `hugo -s tech --themesDir ../themes --minify` |
| Build output | `kids/public` | `tech/public` |
| 環境變數 | `HUGO_VERSION=0.169.0` | `HUGO_VERSION=0.169.0` |

Root 必須是 `/`，`functions/_middleware.js` 才會被部署。`<site>/hugo.toml` 的 `params.ads.client` 與 `params.ads.slots` 留空時不載入廣告；根網域需自行放置 `ads.txt`。上線初期可設 `CSP_REPORT_ONLY=1`，確認後再移除。

- `kids` 的 `ageTreatment = "1"` 與沒有 `top` 版位的設定保留。
- `markup.goldmark.renderer.unsafe` 保持 `false`；Blogger 轉換也會跳脫原始 HTML，只有受限的 YouTube shortcode 產生 iframe。
- `__CSP_NONCE__` 只能出現在 Hugo theme 樣板，不可進入文章內容或外部資料。
