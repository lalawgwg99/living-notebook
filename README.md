# 活筆記 Living Notebook

會自己長大的筆記本。把看到的影片、文章連結或文字丟進來，它會：

1. **自動抓取** — 後端把連結內容抓回來（YouTube 會盡量抓字幕）
2. **摘要重點** — AI 整理成「一句話＋3~5 個重點＋標籤」
3. **自動分類** — AI 把筆記分進對應的「大腦」，全新領域就誕生新大腦
4. **大腦進化** — 每個大腦有自己的知識摘要、想學的缺口、等級；筆記多了會**分裂**，混搭出新領域會**繁衍**，偶爾還會自己寫「思考筆記」
5. **問答** — 想找重點時直接問，大腦們會翻筆記回答

## 架構

- `index.html` / `style.css` / `app.js` — 純靜態前端（Cloudflare Pages），資料存瀏覽器 localStorage
- `config.js` — API 位址設定
- `worker-ingest.js` — Cloudflare Worker：抓連結內容＋ AI 摘要（`notebook-ingest.taicalc.com`）
- AI 人格／分類／進化／問答 — 走共用 `ai-proxy` Worker 的 `notebook-*` 任務

## 設計

D1 一色主義：全站唯一的強調色＝主人格當下的情緒色（AI 會換）；L4 產品即介面：首屏就是筆記本本體。
