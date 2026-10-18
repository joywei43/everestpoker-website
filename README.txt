EVEREST WAITING LIST — 本機測試版

檔案結構：
waiting-list/index.html          玩家頁面
waiting-list/admin/index.html    員工操作頁面

上傳到現有網站的發布目錄，與首頁 index.html 同一層放 waiting-list 資料夾。
不要覆蓋原本首頁、CNAME 或其他網站檔案。

GitHub：開啟網站 repository → Add file → Upload files → 拖入 waiting-list 整個資料夾 → Commit changes。
不要上傳 ZIP 本身。若 Pages 發布資料夾為 docs，則把 waiting-list 放在 docs 裡。

發布後網址：
https://everestpokerroom.com/waiting-list/
https://everestpokerroom.com/waiting-list/admin/

此版無帳號驗證、無伺服器、無跨裝置同步。admin 網址不是登入保護。
資料存於 localStorage，同一個網站來源、同一瀏覽器的分頁同步，清除瀏覽資料會刪除。
首次使用空桌、空候位。序號依遊戲＋級別自動編號，各隊列獨立叫號。
桌號為 1、2、3、5；每桌九席；後台可設定五種級別與 NLH/PLO/Others。
同遊戲同級別共用候位。點空位可將目前選定隊列的已叫號玩家標記入座；這仍是操作原型。
可從後台將有人座位點回空位。

建議用本機 HTTP 伺服器測試，不要以 file:// 比較同步。
在本資料夾執行 python3 -m http.server 8000，瀏覽 localhost:8000/waiting-list/ 及 /waiting-list/admin/。
