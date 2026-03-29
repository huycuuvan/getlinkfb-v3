# Tài Liệu Bàn Giao Dự Án: FB Scraper Automation v3

## 1. Tổng quan dự án
Dự án **getlinkfb-v3** là một hệ thống tự động hóa được thiết kế để theo dõi tin nhắn từ khách hàng trên các Fanpage Facebook, sau đó trích xuất thông tin cá nhân (Tên, Link Profile, Số điện thoại) và đồng bộ hóa dữ liệu này sang **Google Sheets** và hệ thống **N8N**.

### Quy trình hoạt động chính:
1. **Webhook**: Nhận tín hiệu khi có tin nhắn mới từ khách hàng gửi đến Fanpage.
2. **Hàng đợi (Queue)**: Quản lý các yêu cầu xử lý để tránh quá tải server và xung đột trình duyệt.
3. **Trích xuất thông tin**:
    - Sử dụng **Facebook Graph API** để lấy tên khách hàng một cách nhanh nhất.
    - Sử dụng **Playwright (Browser Automation)** để truy cập Meta Business Suite, đồng bộ UI và trích xuất "Link Profile" cá nhân.
4. **Xoay vòng tài khoản**: Hệ thống tự động xoay vòng qua danh sách nhiều nick Facebook phụ (via) để thực hiện quét, nhằm tránh bị Facebook chặn (checkpoint).
5. **Lưu trữ & Đồng bộ**:
    - Lưu vào Google Sheets theo từng Page.
    - Gửi dữ liệu JSON sang N8N Webhook để xử lý các bước tiếp theo (CRM, gửi tin nhắn, v.v.).

---

## 2. Cấu trúc thư mục
```text
/getlinkfb-v3
├── cookies/                # Thư mục chứa các file JSON cookies của nick phụ
├── src/                    # Mã nguồn chính
│   ├── index.js           # Entry point, khởi tạo server Express & Admin API
│   ├── webhook.js         # Xử lý logic Webhook, hàng đợi và luồng chính
│   ├── browser.js         # Tự động hóa trình duyệt (Playwright) để quét profile
│   ├── graph-api.js       # Tương tác với Facebook Graph API
│   ├── sheets.js          # Ghi dữ liệu vào Google Sheets
│   ├── maintenance.js     # Các tác vụ bảo trì (làm mới token/session)
│   └── capture-cookies.js # Script hỗ trợ bắt cookies
├── public/                 # Giao diện web
│   ├── admin.html         # Bảng điều khiển quản trị (Admin Dashboard)
│   └── ... 
├── config.json             # Cấu hình chính (Accounts, Pages, API Keys)
├── .env                    # Biến môi trường (PORT, Headless mode...)
├── service_account.json    # Chứng chỉ kết nối Google Sheets API
└── profile_cache.json      # Bộ nhớ đệm lưu PSID -> Profile Link để tránh quét lại
```

---

## 3. Hướng dẫn cài đặt

### Yêu cầu hệ thống:
- **Node.js**: v16 trở lên.
- **PM2**: Để quản lý quy trình và tự động restart.
- **Trình duyệt**: Playwright sẽ tự tải Chromium khi cài đặt.

### Các bước cài đặt:
1. Giải nén/Clone dự án vào thư mục.
2. Mở terminal tại thư mục gốc và chạy lệnh:
   ```bash
   npm install
   npx playwright install chromium
   ```
3. Cấu hình file `.env` (copy từ `.env.example`).
4. Cấu hình `config.json` và `service_account.json`.
5. Chạy dự án:
   - Chạy thử: `npm start`
   - Chạy production: `pm2 start src/index.js --name fb-scraper`

---

## 4. Cấu hình chi tiết

### 4.1. File `config.json`
Đây là nơi chứa toàn bộ "linh hồn" của hệ thống:
- **`accounts`**: Danh sách các nick Facebook dùng để quét. Mỗi nick cần file cookie tương ứng trong thư mục `cookies/`.
- **`pages`**: Danh sách Fanpage cần theo dõi. Mỗi Page cần:
    - `page_access_token`: Token có quyền `pages_messaging`.
    - `spreadsheet_id`: ID của Google Sheet (lấy từ URL).
    - `sheet_name`: Tên tab trong Sheet (ví dụ: "Sheet1").
- **`n8n_api`**: Địa chỉ Webhook và API Key của hệ thống N8N.

### 4.2. File `service_account.json`
Tải file JSON này từ **Google Cloud Console** (Service Account) và cấp quyền **Editor** cho email của Service Account này trong file Google Sheets bạn muốn ghi dữ liệu.

### 4.3. File `.env`
Các biến quan trọng:
- `PORT`: Cổng chạy server (mặc định 4000).
- `HEADLESS`: `true` để chạy ẩn (mặc định cho server), `false` để hiện cửa sổ trình duyệt (khi debug).
- `FB_COOKIES_PATH`: Đường dẫn mặc định đến file cookies.

---

## 5. Bảng điều khiển Admin (Admin Panel)
Truy cập qua: `http://your-ip:4000/admin`

**Các chức năng chính:**
- **Dashboard**: Theo dõi số lượng khách đang chờ (Queue), trạng thái các Workers và lịch sử xử lý 20 khách gần nhất.
- **Quản lý tài khoản**: Thêm mới hoặc cập nhật Cookies cho các nick phụ trực tiếp trên giao diện web.
- **Biên tập Config**: Sửa trực tiếp file `config.json` mà không cần vào server qua SSH.
- **Restart Service**: Khởi động lại bot để áp dụng các thay đổi cấu hình.

---

## 6. Các lưu ý quan trọng (Maintainer Guide)

### 6.1. Bảo trì Cookies
- Các nick phụ (via) có thể bị logout hoặc hết hạn cookie.
- Nếu thấy trạng thái xử lý báo "failed" liên tục, hãy kiểm tra lại cookies của nick đó trong phần **Tài khoản Scraper** trên Admin Panel.
- Khuyến khích sử dụng cookies định dạng JSON trích xuất từ các extension như J2Team Cookies hoặc Get Cookie.

### 6.2. Hàng đợi và Hiệu năng
- Mặc định hệ thống chạy **1 Worker (MAX_CONCURRENT = 1)** để đảm bảo an toàn cho các tài khoản quét, tránh bị Facebook đánh dấu là spam.
- Nếu số lượng tin nhắn quá lớn dẫn đến hàng đợi bị dồn ứ, có thể cân nhắc tăng `MAX_CONCURRENT` trong `src/webhook.js` và thêm nhiều tài khoản quét hơn.

### 6.3. Google Sheets
- Đảm bảo file Google Sheet đã được chia sẻ quyền chỉnh sửa cho email của Service Account.
- Các cột trong Sheet sẽ được ghi theo thứ tự: `Thời gian`, `PSID`, `Họ tên`, `Link Profile`, `Số điện thoại`, `Tên Page`.

---

## 7. Troubleshooting (Xử lý sự cố)
- **Lỗi Webhook không nhận**: Kiểm tra lại `verify_token` trong `config.json` và cấu hình Webhook trên Facebook Developer App. Đảm bảo server có IP tĩnh hoặc sử dụng Ngrok/Cloudflare Tunnel.
- **Không lấy được Link Profile**: Do UI của Meta Business Suite thay đổi hoặc nick phụ không có quyền xem inbox. Kiểm tra bằng cách đặt `HEADLESS=false` để xem bot thao tác.
- **Bot bị treo**: Sử dụng lệnh `pm2 restart fb-scraper` hoặc bấm nút Restart trên Admin Panel.

---
**Người bàn giao:** Antigravity AI
**Ngày bàn giao:** 23/03/2026
