# 資訊資產管控系統（杏永／杏和／護理之家／診所）

前台＝網頁（靜態檔，可放 GitHub Pages），後台＝Supabase（資料庫＋登入＋權限）。

## 功能
- 設備台帳：電腦、印表機、網路設備、主機、攝影機、門禁、停管（IP、使用人、位置、OS…）
- 人員、主機與系統帳密（加密）、廠商聯絡、交辦事項、知識庫
- 稽核紀錄：所有新增／修改／刪除／查看密碼／變更密碼都記錄操作者與時間，不可修改或刪除，並有雜湊鏈可驗證是否被竄改
- 三種角色：管理者／資訊人員／稽核員（稽核員看不到密碼）
- 查看密碼：需重新輸入登入密碼＋填寫原因，30 秒後自動隱藏
- 總覽：重複 IP、XP/Win7、無 IP、無使用人、離職人員名下資產

## 建置步驟（一次性）
1. 到 supabase.com 建立**新專案**（資料庫密碼自行保管）。
2. Authentication → Sign In / Providers：**關閉 Allow new users to sign up**（重要）。
3. SQL Editor 依序執行 `db/001_schema.sql`、`db/002_functions.sql`。
4. 設定加密金鑰（只做一次，**務必另外備份**，遺失＝所有密碼無法解密）：
   `select private.set_encryption_key('至少24字元的隨機字串');`
5. Authentication → Users → Add user：建立您自己的帳號（Email＋密碼）。再執行：
   `update public.profiles set role='admin', active=true where email='您的Email';`
6. 執行 `seed-private/seed_assets.sql`（610 筆設備、28 廠商、15 交辦；不含任何密碼）。
7. Project Settings → API：複製 Project URL 與 **publishable (anon) key**，填入 `js/config.js`。**絕不可放 secret / service_role key。**
8. 部署 `index.html`、`css/`、`js/`（GitHub Pages 或任何靜態主機）。**不要上傳 `seed-private/`。**
9. 登入後到「匯入帳密」上傳 (SH+SY)PD.xlsx（在瀏覽器內解析，預覽不顯示密碼），確認院區後匯入。
10. 匯入完成後：刪除所有含密碼的 Excel 原檔，並更換這些主機密碼（舊檔含明碼，且部分密碼重複使用）。
11. 其他資訊人員：Auth 後台建立帳號 → 系統「使用者管理」指派角色並啟用。

## 安全說明
- 密碼以 pgcrypto 加密存放，金鑰在不對外的 `private` schema；前端無法讀取密文欄位。
- 具 DBA 權限者（Supabase 專案擁有者）技術上仍可讀取金鑰，請限制專案擁有者人數。
- 稽核鏈可偵測中間被改／刪，但無法偵測「最末幾筆被截掉」，建議定期匯出稽核 XLSX 留存。
- 離職人員：在「使用者管理」停用，不要刪除，紀錄會永久保留。
- 診所：院區已建立，資料之後再補。

## 資料品質待處理（匯入後在總覽可見）
- 重複 IP（如 192.168.1.76）、格式錯誤 IP（如 `192.1681.193`、`232`）、單格多 IP
- 仍在使用 XP／Win7 的電腦；杏和 23 台電腦無 IP
- 購買日期為民國「110.7」格式，110.1 與 110.10 無法區分，已原文保留
- PD 三份檔差異：主檔 vs 敬綸版僅在 6 台設備名稱與防火牆／AP SERVER 帳密不同；主檔 vs 育瑞版 5 台不同、AP SERVER 不同。以主檔為準，差異請人工確認。
