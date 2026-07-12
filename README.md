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

1. Thêm bot vào nhóm CS (nhóm này sẽ vừa nhận **yêu cầu điểm danh** vừa nhận **cảnh báo "chưa điểm danh"**).
2. Trong nhóm, gõ lệnh `/id` — bot sẽ trả về ID của nhóm đó → dán vào `GROUP_CHAT_ID`.
3. Muốn biết ID Telegram của 1 nhân viên (để điền vào file lịch): bảo họ nhắn `/id` cho bot (nhắn riêng hoặc trong nhóm đều được) — **không cần bấm Start hay nhắn riêng trước**, vì bot giờ nhắn yêu cầu điểm danh thẳng vào nhóm và tag tên, không nhắn riêng nữa.
4. **Quan trọng**: bot cần đọc được tin nhắn trong nhóm để nhận diện ảnh reply. Cách chắc chắn nhất: đưa bot lên làm **Admin của nhóm** (Nhóm → Quản trị viên → thêm bot). Nếu không muốn cho bot làm admin, vào **@BotFather** → `/mybots` → chọn bot → **Bot Settings** → **Group Privacy** → **Turn off**, để bot đọc được mọi tin nhắn trong nhóm.

## 4. Định dạng file Excel/CSV lịch tháng (upload thẳng vào bot)

Vì ca làm thay đổi liên tục trong tháng, file KHÔNG dùng 1 giờ vào/ra cố định cho cả tháng — thay vào đó là **1 dòng/người, mỗi ngày trong tháng 1 cột riêng**, ghi đúng giờ ca của ngày đó:

| TelegramID | Ten             | KhuVuc | 1           | 2           | ... | 14  | 15  | 16  | 17  | ... | 20          |
|-----------|-----------------|--------|-------------|-------------|-----|-----|-----|-----|-----|-----|-------------|
| 7537739898| Nguyễn Bảo Trâm | VN     | 12:00-22:00 | 12:00-22:00 | ... | OFF | OFF | OFF | OFF | ... | 08:00-16:00 |

- **TelegramID / Ten / KhuVuc**: giống bản trước — TelegramID bắt buộc (lấy bằng cách bảo nhân viên nhắn `/id` cho bot), KhuVuc để trống = mặc định VN.
- **Cột ngày** (tiêu đề là số 1, 2, 3... tới tối đa 31): mỗi ô ghi giờ ca dạng `HH:mm-HH:mm` (vd `08:00-16:00`, `12h00-22h00` cũng đọc được). Ca qua đêm (vd `22:00-06:00`) bot tự hiểu là qua ngày hôm sau.
- Để **trống** hoặc ghi `OFF` / `Nghỉ` = ngày đó nghỉ, bot không tạo yêu cầu điểm danh cho ngày này.
- Không cần đủ 31 cột — tháng 28/30 ngày thì để tới cột tương ứng, cột dư không dùng tới cũng không sao.

**Bắt buộc ghi tháng áp dụng vào CAPTION khi gửi file** (không ghi thì bot sẽ từ chối và nhắc gửi lại), dạng `MM/YYYY` hoặc `YYYY-MM`, ví dụ caption `08/2026` = lịch áp dụng cho tháng 8/2026.

Gửi file vào **chat riêng với bot**, kèm caption tháng. Bot đọc xong sẽ hiện **3 nút bấm**:
- 🔀 **Merge** — chỉ cập nhật/thêm người có trong file, giữ nguyên lịch của người không có trong file (chỉ áp dụng nếu file cùng tháng với lịch đang lưu).
- 🗑️ **Ghi đè toàn bộ** — xoá sạch lịch cũ, thay hoàn toàn bằng file này (dùng khi lên lịch tháng mới nguyên tháng).
- ❌ **Huỷ** — không áp dụng gì, giữ nguyên lịch cũ.

Lưu ý: nếu file upload là **tháng khác** với lịch đang lưu, bấm nút nào (Merge hay Ghi đè) hệ thống cũng tự động **chuyển hẳn sang lịch tháng mới** — vì cấu trúc theo ngày của 2 tháng khác nhau không thể gộp chung được. Nút bấm hết hạn sau 15 phút nếu không bấm gì (gửi lại file để làm lại).

## 5. Các lệnh admin (chỉ ADMIN_IDS mới dùng được)

- `/dsca` — xem tổng quan lịch tháng đang lưu (số ngày làm/nghỉ mỗi người).
- `/xemca <TelegramID>` — xem chi tiết lịch từng ngày trong tháng của 1 người.
- `/lichhomnay` — xem các mốc điểm danh đã lập lịch cho hôm nay (giờ cụ thể + trạng thái: đang chờ / đã điểm danh / chưa điểm danh). Dùng để kiểm tra ngay không cần đợi, khỏi phải đoán.
- `/baocao` — báo cáo nhanh số lần điểm danh thành công / chưa điểm danh trong ngày.
- Gửi file Excel/CSV kèm caption tháng — cập nhật lịch (xem mục 4).

## 6. Cách hoạt động

- Mỗi 10 phút, bot kiểm tra từng nhân viên: nếu hôm nay (theo múi giờ khu vực của họ) là ngày làm việc và **chưa được lập lịch cho hôm nay**, bot random 2-3 mốc giờ trong đúng khung giờ ca của ngày đó (né 15 phút đầu/cuối ca, cách nhau tối thiểu 45 phút — chỉnh trong `config.js`) rồi lên lịch gửi tin.
- Đến giờ, bot nhắn vào nhóm (`GROUP_CHAT_ID`), **tag tên nhân viên**, yêu cầu **REPLY đúng tin nhắn đó kèm ảnh** tay + màn hình hiện giờ, có `RESPONSE_DEADLINE_MINUTES` (mặc định 10 phút) để phản hồi.
- Nhân viên chỉ cần **reply tin nhắn yêu cầu điểm danh** bằng 1 ảnh bất kỳ → bot tự nhận là đã điểm danh (bot không tự soi ảnh có đúng tay+màn hình+giờ hay không — phần này cần admin xem lại ảnh log nếu nghi ngờ gian lận). Ảnh gửi trong nhóm mà KHÔNG phải reply vào tin nhắn của bot sẽ bị bot bỏ qua (tránh nhiễu với ảnh khác trong nhóm).
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
- Nếu bot vẫn không nhận được ảnh reply trong nhóm dù đã reply đúng tin nhắn, kiểm tra lại đã tắt Group Privacy hoặc thêm bot làm admin nhóm chưa (xem mục 3, bước 4).
- File `data/*.json` là lưu file phẳng — đủ dùng cho vài chục người, nếu số lượng nhân viên lên tới vài trăm+ thì nên chuyển sang DB thật.
