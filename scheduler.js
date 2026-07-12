const cron = require('node-cron');
const {
  getShifts,
  getTodayPlan,
  saveTodayPlan,
  appendAttendanceLog,
} = require('./storage');
const {
  GROUP_CHAT_ID,
  CHECKINS_PER_SHIFT_MIN,
  CHECKINS_PER_SHIFT_MAX,
  SHIFT_EDGE_BUFFER_MINUTES,
  RESPONSE_DEADLINE_MINUTES,
  MIN_GAP_BETWEEN_CHECKINS_MINUTES,
} = require('./config');

// Mui gio theo khu vuc - them dia diem moi o day neu can
const LOCATION_TZ = {
  VN: 'Asia/Ho_Chi_Minh',
  VIETNAM: 'Asia/Ho_Chi_Minh',
  ARM: 'Asia/Yerevan',
  ARMENIA: 'Asia/Yerevan',
};
const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

function getTz(location) {
  const key = String(location || '').trim().toUpperCase();
  return LOCATION_TZ[key] || DEFAULT_TZ;
}

function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const guessUtc = new Date(`${dateStr}T${timeStr}:00.000Z`);
  const asLocalString = guessUtc.toLocaleString('en-US', { timeZone });
  const asLocal = new Date(asLocalString);
  const asUtcString = guessUtc.toLocaleString('en-US', { timeZone: 'UTC' });
  const asUtc = new Date(asUtcString);
  const offset = asUtc.getTime() - asLocal.getTime();
  return new Date(guessUtc.getTime() + offset);
}

function getDateStrInTz(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Lap ke hoach diem danh cho 1 ca lam, cho ngay hom nay theo mui gio rieng cua ca do
function planForShift(shift) {
  const tz = getTz(shift.location);
  const now = new Date();
  const todayStr = getDateStrInTz(now, tz);
  const weekday = new Date(`${todayStr}T00:00:00Z`).getUTCDay();

  if (!shift.days.includes(weekday)) return { todayStr, entries: [] };

  let shiftStartUtc = zonedTimeToUtc(todayStr, shift.shiftStart, tz);
  let shiftEndUtc = zonedTimeToUtc(todayStr, shift.shiftEnd, tz);
  if (shiftEndUtc <= shiftStartUtc) {
    shiftEndUtc = new Date(shiftEndUtc.getTime() + 24 * 60 * 60 * 1000);
  }

  const bufferMs = SHIFT_EDGE_BUFFER_MINUTES * 60 * 1000;
  const windowStart = shiftStartUtc.getTime() + bufferMs;
  const windowEnd = shiftEndUtc.getTime() - bufferMs;
  if (windowEnd <= windowStart) return { todayStr, entries: [] };

  const count = randomInt(CHECKINS_PER_SHIFT_MIN, CHECKINS_PER_SHIFT_MAX);
  const totalMs = windowEnd - windowStart;
  const gapMs = MIN_GAP_BETWEEN_CHECKINS_MINUTES * 60 * 1000;

  const slot = totalMs / count;
  const times = [];
  for (let i = 0; i < count; i++) {
    const slotStart = windowStart + i * slot;
    const slotEnd = windowStart + (i + 1) * slot;
    const maxOffset = Math.max(slotEnd - slotStart - gapMs, 0);
    const t = slotStart + Math.random() * (maxOffset || slotEnd - slotStart);
    times.push(Math.round(t));
  }

  const entries = times
    .filter((t) => t > now.getTime()) // bo moc da qua (vd bot vua khoi dong lai giua ca)
    .map((t) => ({
      id: `${shift.telegramId}_${todayStr}_${t}`,
      telegramId: shift.telegramId,
      name: shift.name,
      planDate: todayStr, // ngay lich (theo mui gio cua ca) ma moc nay thuoc ve
      time: t,
      status: 'pending', // pending | done | missed
      respondedAt: null,
      photoFileId: null,
    }));

  return { todayStr, entries };
}

let scheduledTimers = [];

function clearAllTimers() {
  scheduledTimers.forEach((t) => clearTimeout(t));
  scheduledTimers = [];
}

function scheduleCheckin(bot, entry) {
  const now = Date.now();
  const delay = entry.time - now;
  if (delay > 0) {
    const timer = setTimeout(() => sendCheckinRequest(bot, entry), delay);
    scheduledTimers.push(timer);
  } else {
    sendCheckinRequest(bot, entry);
  }
}

async function sendCheckinRequest(bot, entry) {
  try {
    await bot.telegram.sendMessage(
      entry.telegramId,
      `🔔 YÊU CẦU ĐIỂM DANH\n\nVui lòng chụp ảnh TAY của bạn cùng MÀN HÌNH MÁY TÍNH đang hiển thị GIỜ hiện tại, gửi lại tin nhắn này trong vòng ${RESPONSE_DEADLINE_MINUTES} phút.`
    );
  } catch (err) {
    console.error(`[scheduler] Không gửi được tin nhắn cho ${entry.telegramId}:`, err.message);
  }

  const deadlineTimer = setTimeout(
    () => checkDeadline(bot, entry.id),
    RESPONSE_DEADLINE_MINUTES * 60 * 1000
  );
  scheduledTimers.push(deadlineTimer);
}

async function checkDeadline(bot, entryId) {
  const current = getTodayPlan();
  if (!current) return;
  const entry = current.checkins.find((c) => c.id === entryId);
  if (!entry || entry.status !== 'pending') return; // da diem danh roi thi thoi

  entry.status = 'missed';
  saveTodayPlan(current);

  appendAttendanceLog({
    telegramId: entry.telegramId,
    name: entry.name,
    scheduledTime: new Date(entry.time).toISOString(),
    status: 'missed',
    respondedAt: null,
  });

  if (GROUP_CHAT_ID) {
    const timeStr = new Date(entry.time).toLocaleString('vi-VN');
    try {
      await bot.telegram.sendMessage(
        GROUP_CHAT_ID,
        `⚠️ ${entry.name} (ID: ${entry.telegramId}) CHƯA ĐIỂM DANH cho mốc ${timeStr}.`
      );
    } catch (err) {
      console.error('[scheduler] Không gửi được cảnh báo lên nhóm:', err.message);
    }
  }
}

// Goi khi co ai do gui anh - danh dau diem danh thanh cong neu dang co yeu cau pending
function markCheckinDone(telegramId, photoFileId) {
  const plan = getTodayPlan();
  if (!plan) return null;

  const entry = plan.checkins
    .filter((c) => c.telegramId === String(telegramId) && c.status === 'pending')
    .sort((a, b) => a.time - b.time)[0];

  if (!entry) return null;

  entry.status = 'done';
  entry.respondedAt = Date.now();
  entry.photoFileId = photoFileId;
  saveTodayPlan(plan);

  appendAttendanceLog({
    telegramId: entry.telegramId,
    name: entry.name,
    scheduledTime: new Date(entry.time).toISOString(),
    status: 'done',
    respondedAt: new Date(entry.respondedAt).toISOString(),
  });

  return entry;
}

// Don entry qua cu (planDate hon 2 ngay truoc) de file khong phinh to theo thoi gian.
// Lich su day du van con nguyen trong attendance_log.json.
function pruneOldEntries(plan) {
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  plan.checkins = plan.checkins.filter((c) => c.time > cutoff);
  return plan;
}

// Kiem tra tung ca lam: neu ca do CHUA duoc lap lich cho ngay hien tai (theo mui gio rieng cua ca),
// thi tao moc diem danh ngau nhien moi va lich cho ca do. Cho phep nhieu khu vuc/mui gio khac nhau
// "sang ngay moi" vao thoi diem khac nhau ma khong bi sot ca nao.
function ensureAllShiftsPlanned(bot) {
  const shifts = getShifts();
  let plan = getTodayPlan() || { checkins: [] };
  plan = pruneOldEntries(plan);

  let addedCount = 0;
  Object.values(shifts).forEach((shift) => {
    const { todayStr, entries } = planForShift(shift);
    const alreadyPlanned = plan.checkins.some(
      (c) => c.telegramId === shift.telegramId && c.planDate === todayStr
    );
    if (alreadyPlanned || entries.length === 0) return;

    plan.checkins.push(...entries);
    entries.forEach((entry) => scheduleCheckin(bot, entry));
    addedCount += entries.length;
  });

  saveTodayPlan(plan);
  if (addedCount > 0) {
    console.log(`[scheduler] Đã thêm lịch ${addedCount} lượt điểm danh mới.`);
  }
}

// Goi khi khoi dong server: khoi phuc timer cho cac moc pending con o tuong lai
// (phong truong hop Render restart giua chung), roi kiem tra lap lich cho cac ca chua co.
function bootstrapScheduler(bot) {
  clearAllTimers();
  const plan = getTodayPlan();
  if (plan) {
    plan.checkins
      .filter((c) => c.status === 'pending' && c.time > Date.now())
      .forEach((entry) => scheduleCheckin(bot, entry));
  }
  ensureAllShiftsPlanned(bot);
}

// Dung khi admin upload file ca moi - lap lai lich ngay cho cac ca (chi ap dung cho ca nao
// CHUA duoc lap hom nay; ca da lap roi se giu nguyen de khong xoa cac moc da gui/da diem danh).
function runDailyPlanning(bot) {
  ensureAllShiftsPlanned(bot);
}

function initScheduler(bot) {
  bootstrapScheduler(bot);
  // Kiem tra lai moi 10 phut - dam bao ca nao moi den gio bat dau (o bat ky mui gio nao)
  // deu duoc lap lich kip thoi, khong phai cho den 1 moc gio UTC co dinh.
  cron.schedule('*/10 * * * *', () => ensureAllShiftsPlanned(bot));
}

module.exports = {
  initScheduler,
  runDailyPlanning,
  markCheckinDone,
};
