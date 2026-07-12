# Bot điểm danh ngẫu nhiên qua Telegram

Bot Telegram (Node.js + Telegraf) dùng để:
1. Random giờ trong ca làm để yêu cầu nhân viên chụp ảnh TAY + MÀN HÌNH đang hiện GIỜ.
2. Nhận biết ai đang trong ca nào bằng file Excel/CSV admin upload.
3. Tự đếm ngược, nếu quá hạn chưa gửi ảnh -> cảnh báo lên nhóm + lưu log.

## 1. Cài đặt local

```bash
npm install
cp .env.example .env
# rồi điền BOT_TOKEN, ADMIN_IDS, GROUP_CHAT_ID vào file .env
npm start
```

## 2. Lấy BOT_TOKEN

Nhắn `/newbot` cho **@BotFather** trên Telegram, đặt tên bot, copy token dán vào `.env`.

## 3. Lấy GROUP_CHAT_ID và Telegram ID nhân viên

1. Thêm bot vào nhóm CS (nhóm sẽ nhận cảnh báo "chưa điểm danh").
2. Trong nhóm, gõ lệnh `/id` — bot sẽ trả về ID của nhóm đó → dán vào `GROUP_CHAT_ID`.
3. Mỗi nhân viên **phải bấm Start bot 1 lần trong chat riêng** (bot dùng `sendMessage` tới chat riêng để gửi yêu cầu điểm danh, nên cần nhân viên chủ động start trước — Telegram không cho bot nhắn trước cho người lạ).
4. Muốn biết ID Telegram của 1 người: bảo họ nhắn `/id` trong chat riêng với bot.

## 4. Định dạng file Excel/CSV danh sách ca (upload thẳng vào bot)

Cột (không phân biệt hoa thường, có dấu hay không đều nhận diện được các tên quen thuộc):

| TelegramID | Ten          | KhuVuc | GioBatDau | GioKetThuc | NgayLam |
|-----------|--------------|--------|-----------|------------|---------|
| 111111111 | Nguyen Van A | VN     | 08:00     | 16:00      | T2-T6   |
| 222222222 | Hovhannes B  | ARM    | 09:00     | 18:00      | T2-T7   |
| 333333333 | Tran Thi C   | VN     | 22:00     | 06:00      | T2-T6   |

- **TelegramID**: bắt buộc, lấy bằng cách bảo nhân viên nhắn `/id` cho bot.
- **KhuVuc**: `VN` → giờ Việt Nam (Asia/Ho_Chi_Minh), `ARM` → giờ Armenia (Asia/Yerevan). Để trống = mặc định VN. Muốn thêm khu vực khác thì sửa `LOCATION_TZ` trong `scheduler.js`.
- **GioBatDau / GioKetThuc**: dạng `HH:mm`. Ca qua đêm (vd 22:00–06:00) bot tự hiểu là qua ngày hôm sau.
- **NgayLam**: `T2-T6` (thứ 2 đến thứ 6), hoặc liệt kê `T2,T4,T6`, hoặc để trống = làm cả tuần. Quy ước CN=Chủ nhật.

Gửi file này **thẳng vào chat với bot** (không cần caption gì thêm). Bot sẽ đọc file, báo lại số người đọc được, rồi hiện **3 nút bấm** để bạn chọn:
- 🔀 **Merge** — cập nhật người đã có, thêm người mới, giữ nguyên người không có trong file.
- 🗑️ **Ghi đè toàn bộ** — xoá sạch danh sách cũ, thay hoàn toàn bằng file mới (dùng khi up lịch tháng mới).
- ❌ **Huỷ** — không áp dụng gì cả, giữ nguyên danh sách cũ.

Nút bấm hết hạn sau 15 phút nếu không bấm gì (gửi lại file để làm lại).

## 5. Các lệnh admin (chỉ ADMIN_IDS mới dùng được)

- `/dsca` — xem danh sách ca đang lưu.
- `/baocao` — báo cáo nhanh số lần điểm danh thành công / chưa điểm danh trong ngày.
- Gửi file Excel/CSV — cập nhật danh sách ca (xem mục 4).

## 6. Cách hoạt động

- Mỗi 10 phút, bot kiểm tra từng ca: nếu ca đó đến ngày làm việc và **chưa được lập lịch cho hôm nay**, bot random 2-3 mốc giờ trong ca (né 15 phút đầu/cuối ca, cách nhau tối thiểu 45 phút — chỉnh trong `config.js`) rồi lên lịch gửi tin.
- Đến giờ, bot nhắn riêng cho nhân viên yêu cầu chụp ảnh tay + màn hình hiện giờ, có `RESPONSE_DEADLINE_MINUTES` (mặc định 10 phút) để phản hồi.
- Nhân viên chỉ cần gửi **1 ảnh bất kỳ** trong khung giờ đó vào đúng chat với bot → bot tự nhận là đã điểm danh (bot không tự soi ảnh có đúng tay+màn hình+giờ hay không — phần này cần admin xem lại ảnh log nếu nghi ngờ gian lận).
- Quá hạn không gửi ảnh → bot nhắn cảnh báo vào nhóm CS (`GROUP_CHAT_ID`), lưu vào `data/attendance_log.json`.
- Nếu server bị restart (thường gặp trên Render free/hobby), bot tự khôi phục lại các mốc còn ở tương lai trong ngày, không bị mất lịch.

## 7. Deploy lên Render (giống pattern các tool trước)

1. Push code này lên 1 repo GitHub riêng.
2. Tạo **Web Service** mới trên Render, trỏ vào repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add **Persistent Disk**, mount vào ví dụ `/data`, rồi set biến môi trường `DATA_DIR=/data` (để danh sách ca + log không bị mất khi redeploy).
5. Khai báo các biến môi trường trong `.env.example` ở tab Environment của Render.
6. Bot dùng long-polling (`bot.launch()`), **không cần** cấu hình webhook hay domain public.

## 8. Giới hạn hiện tại (biết trước để không bất ngờ)

- Bot không thể tự động xác minh nội dung ảnh (có đúng tay + màn hình + giờ hay không) — cần admin xem lại log nếu nghi ngờ. Có thể nâng cấp sau bằng cách gọi Claude API (vision) để tự động soi ảnh nếu m cần, t có thể làm thêm phần này.
- Mỗi nhân viên phải bấm `/start` với bot ít nhất 1 lần trước khi bot gửi được tin nhắn riêng cho họ.
- File `data/*.json` là lưu file phẳng — đủ dùng cho vài chục người, nếu số lượng nhân viên lên tới vài trăm+ thì nên chuyển sang DB thật.
