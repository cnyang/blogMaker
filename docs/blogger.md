# blogMaker：Blogger 發布設定

將 Markdown 文章交給 AI 潤稿，產生摘要與標籤，轉成 HTML 後自動發布到 Blogger。文章放在 Git repo，合併到 `main` 後由 GitHub Actions 處理；同一篇文章修改後會更新原本的 Blogger post。

```text
posts/ + kids/content/posts/ + tech/content/posts/
    |
    v
文章驗證 -> AI 潤稿、摘要、標籤 -> HTML 預覽 -> Blogger 草稿或公開文章
                                                |
                                                v
                                      blogger-state 發布紀錄
```

## 本機快速開始

需要 Node.js 24 以上、npm 與 Git。

```bash
npm ci
npm test
npm run validate
npm run preview -- --no-ai
```

開啟 `build/example-first-post.html` 即可看見範例預覽。這些指令不需要 API key；範例的 `publish` 為 `false`，不會上傳到 Blogger。

建立新文章：

```bash
npm run new -- "我的文章標題"
```

編輯產生的 `posts/<uuid>.md`，填入正文。檔案可以重新命名，也能放在 `posts/` 的子目錄，請保留原本的 `id`。

## 文章格式

文章開頭使用 `---` 包住 **JSON front matter**。JSON 同時是 YAML 的子集，但此 repo 僅接受 JSON 寫法，請保留雙引號，不使用 YAML 簡寫、註解或尾端逗號。

```markdown
---
{
  "id": "my-first-post",
  "title": "我的第一篇文章",
  "publish": true,
  "status": "published",
  "ai": true,
  "labels": ["技術", "生活"]
}
---

## 開始寫作

這裡是 Markdown 正文。
```

| 欄位 | 說明 |
| --- | --- |
| `id` | 必填。固定且唯一，1–80 個英數字、`_` 或 `-`，第一個字須為英數字；請勿在發布後更改。 |
| `title` | 必填。文章標題，最多 200 字。相同的開頭 `# 標題` 會自動移除，避免 Blogger 重複顯示。 |
| `publish` | 必填布林值。`true` 才同步；`false` 暫停同步，已發布的遠端文章會保留。 |
| `status` | `published` 公開發布（預設）或 `draft` 儲存草稿。已公開文章改成 `draft` 會取消公開。 |
| `ai` | 預設 `true`。設成 `false` 時直接轉換 Markdown，可自行提供摘要與標籤。 |
| `labels` | 手動標籤，與 AI 建議合併、去除重複；最多 20 個，每個最多 40 字且不含逗號。 |
| `summary` | 選填純文字，最多 400 字；優先使用此摘要，顯示於正文開頭與 Blogger 閱讀更多分隔線之前。 |
| `post_id` | 選填，引號包住的 Blogger post ID。首次接管既有文章時使用。 |

支援 GFM 表格、清單、引用、程式碼區塊、圖片與連結，以及獨立一行的 `{{< youtube id="jNQXAC9IVRw" loading="lazy" >}}`；影片使用 `youtube-nocookie.com` 嵌入。程式碼、連結與影片 ID 皆在 AI 內容保護範圍內。原始 HTML 會顯示為文字；圖片與外部連結須使用完整 `http(s)` URL，連結也接受 `mailto:` 與頁內錨點。**本專案不代管圖片**，請先放到公開可讀的圖床或儲存空間。

## 與 Hugo 共用文章

文章讀取範圍為 `posts/`、`kids/content/posts/`、`tech/content/posts/`，ID 必須在三處唯一。既有 Hugo 文章已轉成 JSON front matter，檔名、正文、日期、標籤、分類與簡介皆保留；範例設定 `publish: false`、`status: "draft"`，不會自動上傳。隱私權頁面留在 Hugo，不會當成 Blogger 文章發布。

```bash
npm run new -- "技術文章" --site tech
npm run new -- "兒童文章" --site kids
```

這兩種文章也會出現在本機的 Hugo 預覽（`hugo server`），不會部署到任何網站。兒童文章的 `kind` 可填 `music`、`facts` 或 `english`（預設 `facts`）。不加 `--site` 則建立在 `posts/`，僅供 Blogger 使用。

共用欄位還包括 Hugo 的 `date`、`tags`、`kind`、`description`。`tags` 會合併進 Blogger labels；`description` 保留給 Hugo，Blogger 摘要由 `summary` 或 AI 提供。`date` 用於 Hugo 顯示與排序，不會指定 Blogger 的發布時間；`publish`／`status` 只控制 Blogger，Hugo 預覽仍依自身規則顯示本機文章。

目前所有文章發布到單一 `BLOGGER_BLOG_ID`，兒童／技術內容以 labels 區分，`--site` 只決定新文章的本機位置。Hugo theme、CSP middleware 與廣告設定不會搬到 Blogger；Blogger 的外觀、隱私權頁、兒童內容設定與 AdSense 需在 Blogger 後台另行設定。

## 設定 AI

在專案根目錄自行建立 `.env`（不納入版本控制），填入 `OPENAI_API_KEY`。預設模型為 `gpt-4.1-mini`，可用 `OPENAI_MODEL` 選擇帳號可使用且支援 Responses Structured Outputs 的其他模型。

```bash
npm run preview
```

此指令會呼叫 AI，將所有文章（包含 `publish: false`）的結果存到 `build/<id>.md`、`.json` 和 `.html`，不會發布。`npm run publish -- --dry-run` 效果相同。

編輯規則在 [`prompts/editor.txt`](../prompts/editor.txt)。AI 會改善段落與用字、提供摘要和標籤；程式會檢查程式碼、行內程式碼與 Markdown 連結網址是否保持一致，若遭改動便中止該篇發布。AI 仍可能改變語意或事實，請先用預覽確認文章；程式無法自動保證事實正確。

AI 的回覆必須通過 JSON 結構、完成狀態及內容檢查；處理失敗時不會改用未潤稿版本繼續發布。文章內容會傳到 OpenAI API，並使用 `store: false`；API 呼叫依你的帳號計費。

## 設定 Blogger OAuth

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立或選擇專案，啟用 **Blogger API v3**。
2. 設定 Google Auth Platform 的應用程式資訊與 Audience。測試期間將自己的 Google 帳號加入 Test users，並設定 Blogger scope：`https://www.googleapis.com/auth/blogger`。
3. 建立 **Desktop app** 類型的 OAuth client，下載 JSON，存成 `credentials/client_secret.json`。
4. 執行以下指令，在這台電腦的瀏覽器開啟終端機提供的網址，登入有 Blogger 編輯權限的 Google 帳號並授權：

```bash
npm run auth -- credentials/client_secret.json
```

指令使用 PKCE 與本機 loopback callback，會產生 `credentials/token.json`，並列出可用的 Blog ID。憑證不會印在終端機，相關檔案已由 `.gitignore` 排除。

在 `.env` 設定：

```dotenv
BLOGGER_BLOG_ID=你的數字BlogID
GOOGLE_TOKEN_FILE=credentials/token.json
OPENAI_API_KEY=你的APIKey
OPENAI_MODEL=gpt-4.1-mini
```

Blog ID 也可從 Blogger 後台網址 `https://www.blogger.com/blog/posts/<BlogID>` 取得。寫入文章需要 OAuth 授權，只有 API key 無法發文。

Google 的 External + Testing OAuth 應用程式使用此 scope 時，refresh token 通常會在 7 天後到期。長期自動化請按 Google 的要求將應用程式改為 In production；如 Google 要求驗證，需完成相應程序。遇到授權失效時重新執行 `npm run auth`，並更新 GitHub Secret。

## 在 blogMaker 啟用 GitHub 自動化

使用現有的 `blogMaker` repo，不需要另建 repository。

在 repo 的 **Settings → Secrets and variables → Actions** 設定：

| 類型 | 名稱 | 內容 |
| --- | --- | --- |
| Secret | `OPENAI_API_KEY` | OpenAI API key |
| Secret | `GOOGLE_CREDENTIALS_JSON` | `credentials/token.json` 的完整內容 |
| Variable | `BLOGGER_BLOG_ID` | Blogger blog 的數字 ID |
| Variable | `OPENAI_MODEL` | 選填，預設 `gpt-4.1-mini` |

也可以在本機執行，透過標準輸入上傳 Google 憑證：

```bash
gh secret set GOOGLE_CREDENTIALS_JSON < credentials/token.json
gh secret set OPENAI_API_KEY
gh variable set BLOGGER_BLOG_ID --body '你的數字BlogID'
```

確認 repo 允許 Actions 執行，且組織政策允許 workflow 使用 `contents: write`，以儲存獨立的 `blogger-state` 分支。此分支只有文章 ID、來源雜湊、狀態與 URL，不含憑證。

平常的發布流程：

1. 建立／修改 `posts/*.md`，設定 `publish: true` 與所需 `status`。
2. 開 PR。CI 會跑測試、驗證與離線 HTML 預覽，不會取得發布憑證。
3. 設定好 `BLOGGER_BLOG_ID` 後，合併到 `main`，Actions 自動 AI 潤稿並發布或更新 Blogger。未設定 Blog ID 時略過發布工作。
4. 在 Actions 的 artifacts 下載潤稿結果與 HTML 預覽。

也可到 **Actions → Markdown to Blogger → Run workflow**：勾選 `dry_run` 只產生 AI 預覽，取消勾選才同步符合條件的文章。手動執行僅接受 `main`，發布工作會讀取最新 `main`，防止重新執行舊 workflow 覆蓋新文章。

## 重跑與失敗復原

每篇文章使用固定 `id` 對應 Blogger post ID。來源、編輯提示、模型或格式版本未變更時會略過，避免再次潤稿與扣款；修改後更新同一篇 post。Blogger 上的手動修改不會主動觸發同步，下一次來源變更時會以 repo 內容覆蓋。

新增文章時先建立草稿，立即記錄 post ID，再切換為公開狀態；每次遠端變更後保存本機 journal。CI 即使中途失敗，也會嘗試把 journal 推到 `blogger-state`，並上傳 artifact。遠端文章內也有隱藏識別註解，可在 journal 尚未保存的失敗情況下協助復原。**Blogger 不提供新增文章的冪等鍵**；網路逾時與遠端索引延遲仍可能造成不確定結果，請先核對 Blogger 再重跑。不要移除文章內的識別註解或刪除狀態分支。

若狀態分支推送失敗，先保存 run artifact 裡的 `state.json`，修正 Actions 權限後重跑；若遠端識別註解也被移除，請將已存在文章的 `post_id` 明確填回文章。紀錄中的 post ID 回傳 404 時會停止，避免自動建立替代文章。

本機發布紀錄預設在 `.blogger/state.json`，CI 紀錄則在遠端 `blogger-state`。建議持續由 CI 管理同一個 blog；若改在本機同步已由 CI 發布的文章，請先下載最新紀錄：

```bash
mkdir -p .blogger
git fetch origin blogger-state
git show FETCH_HEAD:posts.json > .blogger/state.json
npm run publish
```

本機發布後需保留 journal；交回 CI 前應同步紀錄或確認遠端隱藏識別註解完整。避免同時從本機與 CI 發布同一個 blog；CI 內已設定串行發布，本機也有鎖定檔。程序被強制終止時，確認沒有發布程序後才移除 `.blogger/publish.lock`。

刪除本機 Markdown 不會刪除遠端文章，也不會取消公開；如需取消公開，保留文章並設定 `publish: true`、`status: "draft"`。

## videoMaker 影片文章

在 Mac 安裝本專案依賴並使用 Node 24+，設定好原有 Blogger OAuth 與 `BLOGGER_BLOG_ID` 後，使用相鄰 videoMaker 的 TUI：`w` 產文／重試、`p` 預覽、`b` 上傳草稿。GX10 須先部署新增的 Python 文章功能，但不需 Node 或 Blogger 憑證。

```text
GX10 影片 QC -> Ollama 撰寫介紹＋推薦 -> article.json
                                            |
                  Mac TUI -> article-json -> npm run video -> HTML 預覽
                                                     |
                                人工選擇 b -> Blogger 草稿
```

`npm run video` 從標準輸入接收 videoMaker 的 JSON 封包，預設只匯入與離線預覽；`npm run video -- --upload` 才上傳所選的單篇文章。封包來自 videoMaker 的 `article-json <作業>`，不接受任意檔案路徑或外部 HTML。TUI 自動完成傳遞，不必手動複製封包。

文章分成 `category: "kids"` 與 `"husky"`，保存在 `posts/video/<分類>/vmk-<固定識別碼>.md`。`category` 也接受未來手寫文章的 `"tech"`；Hugo 的 `kind` 仍只控制原有兒童版面，兩個欄位用途不同。自動匯入的影片文章提供 Blogger 與單篇 HTML 預覽，不新增第三個 Hugo 站。每支影片一篇，包含內容介紹、推薦觀看理由、YT／FB 播放器與直接連結；知識影片保留來源及授權。FB 標記為 `{{< facebook id="數字影片ID" >}}`，只產生固定 Facebook player 網址，原始 HTML 仍會跳脫。

上傳必須有人工核准及對應目前成片的 YT／FB 雜湊；未上傳影片時仍可先預覽文字，待取得真實 ID 後再次匯入補上播放器。YouTube 私人與 FB 草稿都不代表影片已公開；Blogger 也只儲存草稿，播放器的公開可見性須另到影片平台確認。舊版 YouTube 上傳紀錄缺少 `youtube_sha256` 時會拒絕文章上傳，避免將新文配到舊影片；不會自動補 hash 或重傳影片。

Markdown 維持 `publish: false`、`status: "draft"`、`ai: false`；TUI 上傳只在當次命令中啟用這一篇，不會同步其他文章、公開文章或呼叫 OpenAI。重跑沿用同一篇 Blogger post。請保留本機 `.blogger/state.json`，並讓這些影片文章持續由 TUI 管理；若要改由 CI 管理，先依上方復原流程同步發布紀錄。

## 開發與驗證

```bash
npm run lint
npm test
npm run validate
npm run preview -- --no-ai
./scripts/check.sh  # 含上述檢查與兩個 Hugo 站的建置驗證
```

測試使用假的 OpenAI／Blogger 回覆與本機 bare Git repo，涵蓋文章驗證、HTML、AI 內容保留、OAuth refresh、分頁、草稿轉公開、更新、跳過未變更文章、發布失敗復原與狀態分支。測試不會呼叫付費 API 或寫入真實 Blogger；首次設定完成後，請用 `status: "draft"` 的測試文章驗證實際授權。

## 官方文件

- [Blogger API：使用方式](https://developers.google.com/blogger/docs/3.0/using)
- [Blogger posts：新增](https://developers.google.com/blogger/docs/3.0/reference/posts/insert)、[更新](https://developers.google.com/blogger/docs/3.0/reference/posts/patch)、[發布](https://developers.google.com/blogger/docs/3.0/reference/posts/publish)
- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[refresh token 到期條件](https://developers.google.com/identity/protocols/oauth2#expiration)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)、[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [Marked renderer](https://marked.js.org/using_pro#renderer)
