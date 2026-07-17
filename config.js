require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN, // token bot Telegram
  ADMIN_IDS: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean), // danh sách telegram id của admin (m), được phép upload file ca / xem báo cáo
  GROUP_CHAT_ID: process.env.GROUP_CHAT_ID, // id nhóm sẽ nhận cảnh báo "chưa điểm danh"
  DATA_DIR: process.env.DATA_DIR || './data', // trên Render nhớ trỏ vào persistent disk, vd /data
  PORT: process.env.PORT || 3000,

  // số lần điểm danh ngẫu nhiên trong 1 ca (m chọn 2-3 lần)
  CHECKINS_PER_SHIFT_MIN: 2,
  CHECKINS_PER_SHIFT_MAX: 3,

  // đệm thời gian đầu/cuối ca không random vào (phút) - tránh random đúng lúc mới vào ca / sắp tan ca
  SHIFT_EDGE_BUFFER_MINUTES: 15,

  // thời gian tối đa (phút) để phản hồi ảnh trước khi bị tính là "chưa điểm danh"
  RESPONSE_DEADLINE_MINUTES: parseInt(process.env.RESPONSE_DEADLINE_MINUTES || '10', 10),

  // khoảng cách giữa 2 mốc điểm danh liên tiếp của cùng 1 người (phút) - luôn nằm trong khoảng này
  MIN_GAP_BETWEEN_CHECKINS_MINUTES: 60,
  MAX_GAP_BETWEEN_CHECKINS_MINUTES: 90,
};
