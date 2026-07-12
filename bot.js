const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const { BOT_TOKEN, ADMIN_IDS, GROUP_CHAT_ID } = require('./config');
const { getShifts, getAttendanceLog, getTodayPlan } = require('./storage');
const { parseShiftFile, mergeAndSaveShifts, replaceAndSaveShifts } = require('./shiftManager');
const { markCheckinDone, runDailyPlanning, formatLocalTime } = require('./scheduler');

if (!BOT_TOKEN) {
  throw new Error('Thiếu BOT_TOKEN trong biến môi trường.');
}

const bot = new Telegraf(BOT_TOKEN);

// Luu tam ket qua da parse tu file, cho admin bam nut chon Merge/Ghi de.
// key = token ngau nhien, value = { shifts, errors, count, createdAt }
const pendingUploads = new Map();
const PENDING_TTL_MS = 15 * 60 * 1000; // token het han sau 15 phut neu khong bam nut

function cleanupExpiredUploads() {
  const now = Date.now();
  for (const [token, data] of pendingUploads.entries()) {
    if (now - data.createdAt > PENDING_TTL_MS) pendingUploads.delete(token);
  }
}

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

// Nhan caption dang "08/2026", "2026-08", "8/2026" -> tra ve 'YYYY-MM', hoac null neu khong doc duoc
function parseMonthToken(text) {
  if (!text) return null;
  const str = String(text).trim();

  let m = str.match(/^(\d{4})[-/](\d{1,2})$/); // 2026-08 hoac 2026/8
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;

  m = str.match(/^(\d{1,2})[-/](\d{4})$/); // 08/2026 hoac 8-2026
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;

  return null;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        fs.unlink(destPath, () => reject(err));
      });
  });
}

bot.start((ctx) => {
  ctx.reply(
    'Bot điểm danh đã sẵn sàng.\n\n' +
      'Khi đến giờ, bot sẽ nhắn yêu cầu điểm danh vào nhóm và tag tên bạn. Hãy REPLY đúng tin nhắn đó kèm ảnh TAY + MÀN HÌNH đang hiện GIỜ trong thời gian quy định.'
  );
});

bot.command('id', (ctx) => {
  ctx.reply(`Telegram ID của bạn/nhóm này là: ${ctx.chat.id}`);
});

// Admin gửi file excel/csv lịch tháng -> bot đọc xong sẽ hỏi lại bằng nút bấm: Merge / Ghi đè / Huỷ
// Bắt buộc ghi tháng áp dụng trong caption của file, vd caption "08/2026" hoặc "2026-08"
bot.on('document', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('Bạn không có quyền cập nhật danh sách ca làm.');
  }

  const doc = ctx.message.document;
  const validExt = /\.(xlsx|xls|csv)$/i.test(doc.file_name || '');
  if (!validExt) {
    return ctx.reply('Chỉ nhận file .xlsx, .xls hoặc .csv.');
  }

  const monthStr = parseMonthToken(ctx.message.caption);
  if (!monthStr) {
    return ctx.reply(
      '⚠️ Thiếu tháng áp dụng. Gửi lại file, và ghi CAPTION (chú thích) kèm tháng theo dạng "08/2026" (tháng/năm) khi đính kèm file.'
    );
  }

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const tmpPath = path.join(os.tmpdir(), `shifts_${Date.now()}_${doc.file_name}`);
    await downloadFile(link.href, tmpPath);

    const parsed = parseShiftFile(tmpPath, monthStr);
    fs.unlink(tmpPath, () => {});
    const { errors, count } = parsed;

    if (count === 0) {
      return ctx.reply('Không đọc được dòng nào hợp lệ từ file.\n' + errors.join('\n'));
    }

    cleanupExpiredUploads();
    const token = crypto.randomBytes(4).toString('hex');
    pendingUploads.set(token, { data: parsed, createdAt: Date.now() });

    const currentData = getShifts();
    const currentCount = currentData ? Object.keys(currentData.employees || {}).length : 0;
    const currentMonth = currentData ? currentData.month : null;

    let msg = `📄 Đọc được ${count} người cho tháng ${monthStr}.`;
    if (errors.length) {
      msg += `\n⚠️ ${errors.length} dòng có vấn đề (đã coi ngày lỗi là nghỉ):\n${errors.slice(0, 8).join('\n')}`;
      if (errors.length > 8) msg += `\n... và ${errors.length - 8} dòng khác.`;
    }
    if (currentMonth && currentMonth !== monthStr) {
      msg += `\n\nLịch đang lưu hiện tại là tháng ${currentMonth} (${currentCount} người) — file này là tháng khác nên dù bấm Merge hay Ghi đè, hệ thống đều sẽ CHUYỂN HẲN sang lịch tháng ${monthStr} mới.`;
    } else if (currentMonth === monthStr) {
      msg += `\n\nLịch tháng ${monthStr} hiện đang lưu: ${currentCount} người. Bạn muốn áp dụng file này như thế nào?`;
      msg += `\n• Merge = cập nhật/thêm người có trong file, giữ nguyên người không có trong file.`;
      msg += `\n• Ghi đè = xoá sạch lịch tháng ${monthStr} cũ, thay hoàn toàn bằng file này.`;
    } else {
      msg += `\n\nChưa có lịch nào được lưu trước đó.`;
    }

    ctx.reply(
      msg,
      Markup.inlineKeyboard([
        Markup.button.callback('🔀 Merge', `merge_${token}`),
        Markup.button.callback('🗑️ Ghi đè toàn bộ', `replace_${token}`),
        Markup.button.callback('❌ Huỷ', `cancel_${token}`),
      ])
    );
  } catch (err) {
    console.error('[bot] Lỗi xử lý file ca làm:', err);
    ctx.reply(
      `Có lỗi khi đọc/tải file: ${err.message}\nKiểm tra lại định dạng file (xem README mẫu cột), hoặc gửi lại file lần nữa (có thể do tải file bị gián đoạn).`
    );
  }
});

async function handleUploadDecision(ctx, action) {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery('Bạn không có quyền thao tác này.');
  }

  const token = ctx.match[1];
  const pending = pendingUploads.get(token);
  if (!pending) {
    await ctx.answerCbQuery('Yêu cầu đã hết hạn, gửi lại file nhé.');
    return ctx.editMessageText('⌛ Yêu cầu này đã hết hạn (hoặc đã được xử lý). Gửi lại file để thử lại.');
  }
  pendingUploads.delete(token);

  if (action === 'cancel') {
    await ctx.answerCbQuery('Đã huỷ.');
    return ctx.editMessageText('❌ Đã huỷ, danh sách ca làm giữ nguyên như cũ.');
  }

  if (action === 'replace') {
    replaceAndSaveShifts(pending.data);
  } else {
    mergeAndSaveShifts(pending.data);
  }

  runDailyPlanning(bot);

  const label = action === 'replace' ? 'Ghi đè toàn bộ' : 'Merge';
  await ctx.answerCbQuery('Đã áp dụng!');
  ctx.editMessageText(
    `✅ Đã áp dụng (${label}) ${pending.data.count} người cho tháng ${pending.data.month}.\nLịch điểm danh hôm nay đã được cập nhật.`
  );
}

bot.action(/^merge_(.+)$/, (ctx) => handleUploadDecision(ctx, 'merge'));
bot.action(/^replace_(.+)$/, (ctx) => handleUploadDecision(ctx, 'replace'));
bot.action(/^cancel_(.+)$/, (ctx) => handleUploadDecision(ctx, 'cancel'));

// Nhận ảnh điểm danh - chấp nhận cả nhắn riêng (nếu có) lẫn REPLY vào tin nhắn yêu cầu điểm danh trong nhóm
bot.on('photo', async (ctx) => {
  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
  if (isGroup) {
    const replyTo = ctx.message.reply_to_message;
    const isReplyToBot = replyTo && replyTo.from && replyTo.from.id === ctx.botInfo.id;
    if (!isReplyToBot) return; // anh khong lien quan trong nhom, bo qua, khong tra loi de tranh nhieu
  }

  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  const entry = markCheckinDone(ctx.from.id, largest.file_id);

  if (!entry) {
    return ctx.reply('Hiện không có yêu cầu điểm danh nào đang chờ từ bạn.', {
      reply_to_message_id: ctx.message.message_id,
    });
  }

  const timeStr = formatLocalTime(Date.now(), entry.location);
  ctx.reply(`✅ Đã ghi nhận điểm danh lúc ${timeStr}. Cảm ơn bạn!`, {
    reply_to_message_id: ctx.message.message_id,
  });
});

// Báo cáo nhanh trong ngày - chỉ admin
bot.command('baocao', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Bạn không có quyền xem báo cáo.');

  const log = getAttendanceLog();
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayLog = log.filter((l) => l.scheduledTime.startsWith(todayStr));

  if (todayLog.length === 0) {
    return ctx.reply('Chưa có dữ liệu điểm danh nào hôm nay.');
  }

  const byPerson = {};
  todayLog.forEach((l) => {
    byPerson[l.name] = byPerson[l.name] || { done: 0, missed: 0 };
    byPerson[l.name][l.status === 'done' ? 'done' : 'missed'] += 1;
  });

  let msg = `📊 Báo cáo điểm danh ${todayStr}:\n\n`;
  Object.entries(byPerson).forEach(([name, stat]) => {
    msg += `${name}: ✅ ${stat.done} lần | ⚠️ ${stat.missed} lần chưa điểm danh\n`;
  });
  ctx.reply(msg);
});

// Xem cac moc diem danh da len lich cho HOM NAY (tren toan bo may ngay gan day trong bo nho) - chi admin
bot.command('lichhomnay', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Bạn không có quyền xem.');
  const plan = getTodayPlan();
  if (!plan || plan.checkins.length === 0) {
    return ctx.reply(
      'Chưa có mốc điểm danh nào được lập lịch. Có thể do: chưa upload lịch tháng, hôm nay là ngày nghỉ, hoặc bot vừa khởi động lại và đang chờ chu kỳ kiểm tra 10 phút tiếp theo.'
    );
  }

  const sorted = [...plan.checkins].sort((a, b) => a.time - b.time);
  const statusLabel = { pending: '⏳ chờ', done: '✅ đã điểm danh', missed: '⚠️ chưa điểm danh' };

  let msg = `📋 Các mốc điểm danh đã lập lịch (${sorted.length} mốc):\n\n`;
  sorted.forEach((c) => {
    const timeStr = formatLocalTime(c.time, c.location);
    msg += `${timeStr} — ${c.name}: ${statusLabel[c.status] || c.status}\n`;
  });
  ctx.reply(msg);
});
bot.command('dsca', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Bạn không có quyền xem.');
  const data = getShifts();
  if (!data || !data.employees || Object.keys(data.employees).length === 0) {
    return ctx.reply('Chưa có lịch nào được lưu. Gửi file excel/csv (kèm caption tháng, vd "08/2026") để thêm.');
  }

  const employees = Object.values(data.employees);
  let msg = `📅 Lịch tháng ${data.month} (${employees.length} người):\n\n`;
  employees.forEach((e) => {
    const days = Object.values(e.daily);
    const workDays = days.filter((d) => d).length;
    const offDays = days.length - workDays;
    msg += `${e.name} (${e.location || '-'}, ID ${e.telegramId}): ${workDays} ngày làm, ${offDays} ngày nghỉ\n`;
  });
  msg += `\nXem chi tiết từng ngày của 1 người: /xemca <TelegramID>`;
  ctx.reply(msg);
});

// Xem chi tiet lich 1 nguoi trong thang - chi admin
bot.command('xemca', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Bạn không có quyền xem.');
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!arg) return ctx.reply('Dùng: /xemca <TelegramID>');

  const data = getShifts();
  const emp = data && data.employees ? data.employees[arg] : null;
  if (!emp) return ctx.reply(`Không tìm thấy ai với TelegramID ${arg} trong lịch tháng ${data ? data.month : '(chưa có)'}.`);

  const days = Object.keys(emp.daily)
    .map((d) => parseInt(d, 10))
    .sort((a, b) => a - b);

  let msg = `📅 Lịch tháng ${data.month} — ${emp.name} (${emp.location || '-'}):\n\n`;
  days.forEach((d) => {
    const shift = emp.daily[d];
    msg += shift ? `Ngày ${d}: ${shift.start} - ${shift.end}\n` : `Ngày ${d}: nghỉ\n`;
  });
  ctx.reply(msg);
});

module.exports = bot;
