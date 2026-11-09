---
{
  "id": "tech-threejs-skills-security-audit",
  "title": "Three.js Skills 只有 Markdown，為什麼安全風險仍評為中等？",
  "date": "2026-11-09",
  "category": "tech",
  "publish": false,
  "status": "draft",
  "ai": false,
  "labels": ["技術", "AI Skills", "安全審查"],
  "tags": ["Three.js", "供應鏈安全", "原始碼審查"],
  "summary": "CloudAI-X/threejs-skills 的固定版本稽核未發現刻意提示注入、憑證竊取或後門證據，整體仍評為中等風險。原因在於 Markdown 範例可能引導 Agent 執行未固定版本的套件，或讓應用載入遠端模組與解碼器。本文依既有靜態稽核整理五項發現、採用方式與未驗證範圍。",
  "description": "從未固定版本的 npx、CDN 模組、模型載入與安裝範圍，理解 Three.js 技能文件的信任界線。"
}
---

在 [CloudAI-X/threejs-skills 的受審版本](https://github.com/CloudAI-X/threejs-skills/tree/0e181866f095b5f06d005133876e926515390d95) 中，Git 追蹤的 15 個檔案全部是一般、不可執行的文件：13 份 `SKILL.md`、一份 README 與一份 MIT LICENSE。沒有 `package.json`、lockfile，也沒有儲存庫自帶的獨立執行腳本。

2026 年 11 月 5 日的既有靜態稽核，仍把這個版本的整體風險評為 **MEDIUM，中等**。理由來自文件可能引導 Agent 採取的動作：執行未固定版本的第三方套件，以及建立會信任遠端可執行程式碼的應用。

原稽核沒有發現刻意提示注入、憑證竊取、私人資料外傳、隱藏執行載荷或儲存庫後門的證據。這項結果有明確邊界，不能當成安全認證，也不能延伸為替文件提到的所有外部工具背書。

本文將該報告整理成採用前可讀的說明。審查版本限定在 commit `0e181866f095b5f06d005133876e926515390d95`；本次編稿沒有重新安裝技能、執行範例或查核最新版。

## 文件會影響 Agent 接下來做什麼

這個技能庫涵蓋動畫、資產處理、場景基礎、幾何、互動、燈光、載入器、材質、效能、後處理、React Three Fiber、Shader 與貼圖。

多數內容屬於圖形開發參考，但技能文件也會被 Agent 當作行動指引。當內容從說明 API 進一步要求安裝工具、轉換檔案或開啟網頁預覽，信任範圍就會擴大。

```text
讀取技能文件
    |
    +--> 執行 npx / 原生工具 --> 本機程序權限、檔案與網路
    |
    +--> 開啟應用預覽 -------> 遠端模組、解碼器與資產
    |
    +--> 接受模型或貼圖 ------> 解析器、記憶體與 GPU 資源
```

原報告把 asset-pipeline、fundamentals 與 react-three-fiber 三份技能列為中等風險，其餘十份列為低風險。這些是對受審內容及可能衍生行為的評估，低風險也不代表任何輸入、部署方式或外部套件都已獲得安全保證。

## 發現一：未固定版本的 npx，仍可能執行第三方程式

README 提供了這類安裝指令：

```text
npx skills add cloudai-x/threejs-skills
```

[資產處理技能](https://github.com/CloudAI-X/threejs-skills/blob/0e181866f095b5f06d005133876e926515390d95/skills/threejs-asset-pipeline/SKILL.md#L15) 也包含 `npx @gltf-transform/cli` 與 `npx gltfjsx`，並提及 KTX 原生工具及可建立、執行的 SDK pipeline。這些片段在本文中只作為審查證據，沒有執行。

原報告指出，當合適的套件尚未安裝時，`npx` 可能解析、下載並執行套件；實際行為還受 npm 版本、快取、現有依賴與設定影響。這些命令沒有選定精確套件版本，也沒有附上已提交的 lockfile。README 宣稱測過某些版本，並不會替命令固定解析結果。

風險在於，一旦 Agent 執行這些命令，第三方程式就會以該程序持有的權限存取檔案與網路；套件安裝也可能涉及生命週期腳本或原生工具。原稽核沒有檢查這些外部套件的實際發行檔與相依樹，因此無法把對 Markdown 的檢查結果延伸到它們。

報告也保留了誤判界線：這些工具與 3D 資產工作有關，沒有證據顯示它們在這個儲存庫裡被當成惡意下載器。該發現是「未固定解析結果與執行權限帶來供應鏈風險」，不是確認了惡意遠端程式碼執行。

## 發現二：遠端模組與解碼器，也需要列入依賴管理

[fundamentals 的 import map](https://github.com/CloudAI-X/threejs-skills/blob/0e181866f095b5f06d005133876e926515390d95/skills/threejs-fundamentals/SKILL.md#L56) 從 jsDelivr 載入 Three.js、addons、WebGPU 與 TSL 模組，範例 URL 固定到 `three@0.186.0`。這降低了版本漂移，但範例沒有獨立驗證下載內容的完整性。

[React Three Fiber 技能](https://github.com/CloudAI-X/threejs-skills/blob/0e181866f095b5f06d005133876e926515390d95/skills/threejs-react-three-fiber/SKILL.md#L224) 則示範 `<Environment preset="city" />`，讓依賴套件決定環境資產來源。文件也描述 `useGLTF` 預設從 gstatic 取得固定版本的 Draco decoder，並提供設定解碼器路徑或停用 Draco 的替代方式。

原報告提醒，解碼器可能包含會執行的 JavaScript 或 WASM；模型路徑寫成相對路徑，也不代表其餘資源全部離線。至於確切 decoder URL、環境 preset 的主機與預設字型解析行為，由於相依實作及下載內容不在受審儲存庫裡，這次靜態稽核沒有完成驗證。

這些是常見的網頁圖形依賴方式，沒有證據可把 CDN 或 gstatic 的使用本身稱作後門。報告提出的處理方向，是使用經審查、已鎖定的本機 bundle，明確設定解碼器、字型與資產路徑，再用測試過的 CSP 限制可載入的來源。

## 發現三：模型檔案也有來源與資源限制問題

[loaders 技能](https://github.com/CloudAI-X/threejs-skills/blob/0e181866f095b5f06d005133876e926515390d95/skills/threejs-loaders/SKILL.md#L367) 有先取得模型、讀入完整 `ArrayBuffer`，再交給 `GLTFLoader.parseAsync` 的範例。原報告指出，該片段沒有明確檢查回應狀態、大小或格式；其他範例也涵蓋 MTL／OBJ、USD／USDZ 與資源路徑改寫。

當應用開始接受使用者提供的模型 URL 或檔案，限制就要涵蓋解析後的附屬資源，而不只是最上層網址。模型可以參照其他貼圖或資源；壓縮檔大小、解壓後用量、貼圖尺寸、幾何數量、worker 與 GPU 配額，都可能影響應用是否能穩定運作。

報告將這項發現列為低風險的防禦補強缺口。多數範例使用固定的相對檔名，「輸入由攻擊者控制」是把範例改造成上傳服務時才成立的假設。它沒有示範出伺服器端 SSRF、任意讀取本機檔案或解析器漏洞。

原技能也已有 30 秒取消的示範，並說明部分 image-element loader 不受該機制控制。逾時與取消有用，但仍要另外控制記憶體和解析成本。

## 發現四：全域安裝會擴大技能影響範圍

[README 的安裝方式](https://github.com/CloudAI-X/threejs-skills/blob/0e181866f095b5f06d005133876e926515390d95/README.md#L22) 包含未指定 commit 的 clone，以及把所有技能複製到 `~/.claude/skills/` 的全域選項，也提供專案內 `.claude/skills/` 的替代方式。

全域複製會讓這些指引出現在其他專案的可載入範圍，並可能取代同名技能。若安裝來源來自持續變動的分支，日後取得的檔案也不一定與這份稽核相同。

原報告沒有因此把它判成持續駐留的惡意程式。受審的複製範例沒有背景服務、cron、自動更新器或秘密存取行為；讀取 Markdown 本身也不會安裝任何東西。採用上的重點，是固定 commit、只取需要的技能，並先確認複製目的地是否已有內容。

## 發現五：忽略單一診斷，不等於略過所有驗證

資產處理範例中有這個命令：

```text
npx @gltf-transform/cli validate model.glb --ignore ACCESSOR_WEIGHTS_NON_NORMALIZED
```

原報告將它列為低風險發現：這個旗標會隱藏一種 skin-weight 資料診斷，若直接放進 CI，可能讓驗證的效果弱於預期。它只針對單一領域診斷，沒有證據顯示這是在要求 Agent 略過使用者權限、核准或安全政策，也沒有展示與該診斷直接相關的程式碼執行漏洞。

對已知 exporter 的特定狀況，窄範圍例外可能有用途。原報告建議預設保留完整驗證，只有在確認資產與原因之後，才記錄並使用例外。

## 哪些字眼不應直接當成惡意證據

這份稽核也花了篇幅排除容易混淆的情況。Shader 文件中的「injection points」指的是圖形 Shader 的插入位置；動畫或材質中的「override」描述場景屬性；互動技能裡的鍵盤事件用於本機控制，沒有觀察到錄製並傳送按鍵的行為。

同樣地，`VideoTexture` 與 `VideoDecoder` 的範例沒有存取攝影機或麥克風；固定數量粒子的 GPU compute 範例，也沒有被認定為隱藏挖礦。原稽核沒有發現要求讀取 SSH key、雲端憑證、環境 token 或瀏覽器 Cookie 的內容，也沒有識別出私人資料流向外部端點的路徑。

原報告逐一比對受審檔案與 Git blob，並保存 SHA-256 清單；對隱藏檔案、連結、模式與編碼內容的檢查，也沒有找出隱藏執行載荷。這些結果縮小了已觀察到的攻擊面，仍不能替未經稽核的外部套件行為作保。

## 可以採用到哪個程度？

原報告支持的是有條件、限縮範圍的採用方式：從固定 commit 選取已讀過的技能，先放在需要它的專案裡；更新前比較變更內容；安裝與執行工具另行審查版本、依賴、權限及輸出位置。

對資產轉換，保留原檔並另寫輸出；對應用預覽，先確認會載入哪些模組、解碼器與資產；對不可信的模型輸入，先建立來源與資源上限。不要因為一段命令出現在技能裡，就讓 Agent 自動執行。

這份稽核只涵蓋指定 commit 的本機靜態分析。它沒有安裝依賴、執行 JavaScript、開啟瀏覽器預覽、測試 renderer、連線取得 CDN 內容，或查詢外部漏洞公告。Three.js、React、解碼器、原生圖片工具與瀏覽器／GPU 驅動的可利用性，也不在它已驗證的範圍內。

---

編稿依據：`threejs-skills-security-audit.md`。原稽核日期為 2026-11-05，本文於 2026-11-09 整理。風險等級、原始碼位置與未驗證範圍均來自該份固定版本報告，不能作為最新版安全狀態的宣稱。
