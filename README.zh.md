# ChatGPT Browser Memory Reducer 使用說明

`chatgpt-browser-memory-reducer.user.js` 是一個給 Tampermonkey / Violentmonkey 的 userscript，目標是降低 ChatGPT 長對話在瀏覽器中的記憶體占用與卡頓。

它會把較舊訊息收合成摘要卡片，完整內容存到 IndexedDB，並可隨時展開；同時提供訊息索引、emoji 書籤與書籤篩選。

## 主要功能

- 自動收合舊訊息，只保留最新 `10` 則原樣顯示（可改常數）。
- 收合卡顯示角色與預覽，按「展開」可還原完整內容。
- 完整內容存入 IndexedDB，避免只留在記憶體。
- 每則訊息右上顯示索引徽章（例如 `35/120`），可快速捲動定位。
- `Shift + 點擊`索引徽章：切換該則的「預設 emoji 書籤」。
- 索引旁 `+` 按鈕可管理該則的 emoji 書籤（可多選）。
- 右下書籤面板支援：
  - 直接輸入編號跳轉
  - 下拉選單跳到已加書籤訊息
  - 「收合已展開」
  - 「篩選」書籤類別
- 篩選啟用後：僅顯示被選中的書籤類別訊息 + 最後 10 則最新訊息。
- 被篩掉的連續區段會被合併成可展開的群組卡，避免畫面過長。

## 安裝

## 1) 安裝腳本管理器

建議使用以下其中一個：

- Tampermonkey
- Violentmonkey

## 2) 安裝 userscript

將 `chatgpt-browser-memory-reducer.user.js` 匯入腳本管理器，或使用腳本內 `@downloadURL` 安裝。

可直接安裝連結：

- https://gist.github.com/b1e7051e064b4ad8084efa16edc4fbf8/raw/chatgpt-browser-memory-reducer.user.js

## 3) 開啟 ChatGPT

支援：

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

載入對話頁後，腳本會自動啟用。

## 使用方式

- 舊訊息會被自動收合，卡片上點「展開」可還原。
- 展開後訊息底部有「收合此則」按鈕。
- 右下浮動面板：
  - `編號`欄位輸入數字可跳到對應訊息（Enter 立即跳、滾輪可遞增/遞減）。
  - `書籤下拉`可直接跳到已標記的訊息。
  - `篩選`可只看特定 emoji 類別。
- 訊息索引徽章：
  - 一般點擊：捲動到該則訊息。
  - `Shift + 點擊`：切換預設書籤 emoji。
  - 點 `+`：開啟該則的 emoji 書籤設定。

## 資料儲存與隱私

腳本只使用瀏覽器本機儲存，不會把內容送到外部伺服器：

- IndexedDB
  - DB: `chatgpt-browser-memory-reducer`
  - Store: `messages`
  - 用途：儲存被收合訊息的完整 HTML 快照
- localStorage
  - `mr-bookmarks:<route>`：每個對話路由的書籤
  - `mr-bookmark-emoji-catalog:v1`：emoji 類別清單
  - `mr-bookmark-filter-selection:v1`：篩選選取狀態

> `<route>` 是 `pathname + search`，代表不同對話 URL 會有不同書籤集合。

## 可調參數（進階）

可直接編輯腳本頂部常數：

- `KEEP_LATEST = 10`：保留不收合的最新訊息數
- `PREVIEW_CHARS = 320`：收合卡預覽字數
- `MAX_COMPACT_PER_RUN = 10`：每輪最多收合數量
- `PERIODIC_COMPACT_MS = 1500`：週期檢查間隔
- `HOT_CACHE_LIMIT = 8`：記憶體熱快取筆數

## 已知限制

- 依賴 ChatGPT 前端 DOM 結構；若站方改版，功能可能需要調整。
- 收合內容為當下 DOM 的 HTML 快照；若你注入了其他擴充 UI，展開時可能一併保留其標記。
- 若瀏覽器清除網站資料，書籤與快照會消失。

## 疑難排解

- 看不到面板或索引：重新整理頁面，確認腳本在該網域啟用。
- 展開失敗或資料異常：
  - 先重新整理。
  - 再清除此站的 IndexedDB / localStorage 後重試。
- 若和其他 userscript 衝突：先停用其他腳本交叉驗證。

## 授權

本專案採用 MIT 授權，詳見 `LICENSE`。
