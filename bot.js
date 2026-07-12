const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const { BOT_TOKEN, ADMIN_IDS, GROUP_CHAT_ID } = require('./config');
const { getShifts, getAttendanceLog } = require('./storage');
const { parseShiftFile, mergeAndSaveShifts, replaceAndSaveShifts } = require('./shiftManager');
const { markCheckinDone, runDailyPlanning } = require('./scheduler');

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
      'Nếu bạn nhận được yêu cầu điểm danh, hãy chụp ảnh TAY + MÀN HÌNH đang hiện GIỜ và gửi lại đây trong thời gian quy định.'
  );
});

bot.command('id', (ctx) => {
  ctx.reply(`Telegram ID của bạn/nhóm này là: ${ctx.chat.id}`);
});

// Admin gửi file excel/csv danh sách ca -> bot đọc xong sẽ hỏi lại bằng nút bấm: Merge / Ghi đè / Huỷ
bot.on('document', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('Bạn không có quyền cập nhật danh sách ca làm.');
  }

  const doc = ctx.message.document;
  const validExt = /\.(xlsx|xls|csv)$/i.test(doc.file_name || '');
  if (!validExt) {
    return ctx.reply('Chỉ nhận file .xlsx, .xls hoặc .csv.');
  }

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const tmpPath = path.join(os.tmpdir(), `shifts_${Date.now()}_${doc.file_name}`);
    await downloadFile(link.href, tmpPath);

    const { shifts, errors, count } = parseShiftFile(tmpPath);
    fs.unlink(tmpPath, () => {});

    if (count === 0) {
      return ctx.reply('Không đọc được dòng nào hợp lệ từ file.\n' + errors.join('\n'));
    }

    cleanupExpiredUploads();
    const token = crypto.randomBytes(4).toString('hex');
    pendingUploads.set(token, { shifts, errors, count, createdAt: Date.now() });

    const currentCount = Object.keys(getShifts()).length;
    let msg = `📄 Đọc được ${count} người từ file.`;
    if (errors.length) {
      msg += `\n⚠️ Bỏ qua ${errors.length} dòng lỗi:\n${errors.slice(0, 8).join('\n')}`;
      if (errors.length > 8) msg += `\n... và ${errors.length - 8} dòng khác.`;
    }
    msg += `\n\nDanh sách hiện đang lưu: ${currentCount} người.`;
    msg += `\nBạn muốn áp dụng file này như thế nào?`;
    msg += `\n• Merge = cập nhật/thêm mới, giữ nguyên người không có trong file.`;
    msg += `\n• Ghi đè = xoá sạch danh sách cũ, thay hoàn toàn bằng file này.`;

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
    ctx.reply('Có lỗi khi đọc file, kiểm tra lại định dạng file (xem README mẫu cột).');
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
    replaceAndSaveShifts(pending.shifts);
  } else {
    mergeAndSaveShifts(pending.shifts);
  }

  runDailyPlanning(bot);

  const label = action === 'replace' ? 'Ghi đè toàn bộ' : 'Merge';
  await ctx.answerCbQuery('Đã áp dụng!');
  ctx.editMessageText(
    `✅ Đã áp dụng (${label}) ${pending.count} người vào danh sách ca làm.\nLịch điểm danh hôm nay đã được cập nhật.`
  );
}

bot.action(/^merge_(.+)$/, (ctx) => handleUploadDecision(ctx, 'merge'));
bot.action(/^replace_(.+)$/, (ctx) => handleUploadDecision(ctx, 'replace'));
bot.action(/^cancel_(.+)$/, (ctx) => handleUploadDecision(ctx, 'cancel'));

// Nhận ảnh điểm danh
bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  const entry = markCheckinDone(ctx.from.id, largest.file_id);

  if (!entry) {
    return ctx.reply('Hiện không có yêu cầu điểm danh nào đang chờ từ bạn.');
  }

  const timeStr = new Date().toLocaleString('vi-VN');
  ctx.reply(`✅ Đã ghi nhận điểm danh lúc ${timeStr}. Cảm ơn bạn!`);
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

// Xem danh sách ca đang lưu - chỉ admin
bot.command('dsca', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Bạn không có quyền xem.');
  const shifts = Object.values(getShifts());
  if (shifts.length === 0) return ctx.reply('Chưa có danh sách ca nào. Gửi file excel/csv để thêm.');

  let msg = `Danh sách ca làm (${shifts.length} người):\n\n`;
  shifts.forEach((s) => {
    msg += `${s.name} (${s.location || '-'}): ${s.shiftStart}-${s.shiftEnd}, ngày: ${s.days.join(',')}\n`;
  });
  ctx.reply(msg);
});

module.exports = bot;
