const cron = require('node-cron');
const {
  getShifts,
  getTodayPlan,
  updateTodayPlan,
  appendAttendanceLog,
} = require('./storage');
const {
  GROUP_CHAT_ID,
  CHECKINS_PER_SHIFT_MIN,
  CHECKINS_PER_SHIFT_MAX,
  SHIFT_EDGE_BUFFER_MINUTES,
  RESPONSE_DEADLINE_MINUTES,
  MIN_GAP_BETWEEN_CHECKINS_MINUTES,
  MAX_EDGE_SLACK_MINUTES,
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

// Format 1 mocs gio (epoch ms) theo dung mui gio cua khu vuc (VN/ARM...) thay vi mui gio server (UTC tren Render)
function formatLocalTime(ms, location) {
  const tz = getTz(location);
  return new Date(ms).toLocaleString('vi-VN', { timeZone: tz });
}

// Lap ke hoach diem danh cho 1 nhan vien, cho ngay hom nay theo mui gio rieng cua ho.
// shift = { telegramId, name, location, daily: { [dayOfMonth]: {start,end} | null } }
// shiftMonth = 'YYYY-MM' cua lich dang luu - dung de doi chieu voi thang hien tai cua nhan vien do
function planForShift(shift, shiftMonth) {
  const tz = getTz(shift.location);
  const now = new Date();
  const todayStr = getDateStrInTz(now, tz); // 'YYYY-MM-DD'
  const [yearStr, monthStr, dayStr] = todayStr.split('-');
  const currentMonthKey = `${yearStr}-${monthStr}`;
  const dayOfMonth = parseInt(dayStr, 10);

  if (currentMonthKey !== shiftMonth) {
    // Chua co lich cho thang hien tai cua nhan vien nay -> khong lap gi ca
    return { todayStr, entries: [] };
  }

  const today = shift.daily[dayOfMonth] || shift.daily[String(dayOfMonth)];
  if (!today) return { todayStr, entries: [] }; // nghi hoac khong co du lieu ngay nay

  let shiftStartUtc = zonedTimeToUtc(todayStr, today.start, tz);
  let shiftEndUtc = zonedTimeToUtc(todayStr, today.end, tz);
  if (shiftEndUtc <= shiftStartUtc) {
    shiftEndUtc = new Date(shiftEndUtc.getTime() + 24 * 60 * 60 * 1000);
  }

  const bufferMs = SHIFT_EDGE_BUFFER_MINUTES * 60 * 1000;
  const shiftWindowStart = shiftStartUtc.getTime() + bufferMs;
  const windowEnd = shiftEndUtc.getTime() - bufferMs;
  // Neu bot moi lap lich luc ca da dien ra duoc 1 luc (vd bot vua deploy/restart giua ca),
  // tinh tu THOI DIEM HIEN TAI thay vi tu dau ca, de khong bi mat bot mocs random do da "qua gio".
  const windowStart = Math.max(shiftWindowStart, now.getTime() + 60 * 1000);
  if (windowEnd <= windowStart) return { todayStr, entries: [] };

  const gapMs = MIN_GAP_BETWEEN_CHECKINS_MINUTES * 60 * 1000;
  const totalMs = windowEnd - windowStart;

  // So mocs mong muon (2-3), nhung neu khung gio con lai qua ngan (vd bot moi lap lich luc ca
  // sap het) thi TU CO GIAN xuong it mocs hon de van dam bao dung khoang cach toi thieu giua cac mocs -
  // khong nhoi ep nhieu mocs vao khung gio ngan gay ra cac mocs qua gan nhau.
  const desiredCount = randomInt(CHECKINS_PER_SHIFT_MIN, CHECKINS_PER_SHIFT_MAX);
  const maxFeasibleCount = Math.max(1, Math.floor(totalMs / gapMs) + 1);
  const count = Math.min(desiredCount, maxFeasibleCount);

  // Phan bo ngau nhien nhung van dam bao khoang cach >= gapMs giua 2 mocs lien tiep, DONG THOI
  // gioi han slack o 2 dau (truoc moc dau / sau moc cuoi) de luon co it nhat 1 moc gan dau ca
  // va 1 moc gan cuoi ca - khong de "khoang du" ngau nhien don het vao 1 phia (vd don het vao
  // sau moc cuoi lam mat mocs gan gio tan ca).
  const mandatoryMs = (count - 1) * gapMs;
  const slack = Math.max(0, totalMs - mandatoryMs);
  const maxEdgeMs = MAX_EDGE_SLACK_MINUTES * 60 * 1000;

  let edgeBefore = Math.random() * Math.min(maxEdgeMs, slack);
  let edgeAfter = Math.random() * Math.min(maxEdgeMs, Math.max(0, slack - edgeBefore));
  let middleSlack = Math.max(0, slack - edgeBefore - edgeAfter);

  const times = [];
  if (count === 1) {
    // chi 1 moc thi random tu do trong ca, khong can gioi han edge
    times.push(Math.round(windowStart + Math.random() * totalMs));
  } else {
    const middleCuts = Array.from({ length: count - 1 }, () => Math.random());
    const middleCutSum = middleCuts.reduce((a, b) => a + b, 0) || 1;
    const middleParts = middleCuts.map((c) => (c / middleCutSum) * middleSlack);

    let cursor = windowStart + edgeBefore;
    for (let i = 0; i < count; i++) {
      times.push(Math.round(cursor));
      if (i < count - 1) cursor += gapMs + middleParts[i];
    }
  }

  const entries = times
    .filter((t) => t > now.getTime()) // bo moc da qua (vd bot vua khoi dong lai giua ca)
    .map((t) => ({
      id: `${shift.telegramId}_${todayStr}_${t}`,
      telegramId: shift.telegramId,
      name: shift.name,
      location: shift.location, // luu lai de hien thi dung mui gio sau nay
      planDate: todayStr, // ngay lich (theo mui gio cua nhan vien) ma moc nay thuoc ve
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
  if (!GROUP_CHAT_ID) {
    console.error('[scheduler] Chưa cấu hình GROUP_CHAT_ID, không gửi được yêu cầu điểm danh.');
    return;
  }

  try {
    const mention = await resolveMention(bot, entry.telegramId, entry.name);
    const sent = await bot.telegram.sendMessage(
      GROUP_CHAT_ID,
      `🔔 ${mention} YÊU CẦU ĐIỂM DANH\n\nVui lòng REPLY tin nhắn này kèm ảnh TAY của bạn cùng MÀN HÌNH MÁY TÍNH đang hiển thị GIỜ hiện tại, trong vòng ${RESPONSE_DEADLINE_MINUTES} phút.`,
      { parse_mode: 'Markdown' }
    );

    await updateTodayPlan((plan) => {
      const e = plan.checkins.find((c) => c.id === entry.id);
      if (e) e.requestMessageId = sent.message_id;
      return plan;
    });
  } catch (err) {
    console.error(`[scheduler] Không gửi được yêu cầu điểm danh cho ${entry.telegramId}:`, err.message);
  }

  const deadlineTimer = setTimeout(
    () => checkDeadline(bot, entry.id),
    RESPONSE_DEADLINE_MINUTES * 60 * 1000
  );
  scheduledTimers.push(deadlineTimer);
}

function escapeMarkdown(text) {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// Lay thong tin thanh vien that trong nhom de tag chinh xac:
// - Uu tien @username that neu co (luon tag/thong bao duoc chac chan)
// - Neu khong co username, dung mention link tg://user?id=... (goi getChatMember truoc
//   cung giup Telegram "biet" user nay trong nhom nen mention link moi hien thi dung, khong bi rot ve chu thuong)
async function resolveMention(bot, telegramId, fallbackName) {
  try {
    const member = await bot.telegram.getChatMember(GROUP_CHAT_ID, telegramId);
    const user = member.user;
    if (user.username) return `@${user.username}`;
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || fallbackName;
    return `[${escapeMarkdown(fullName)}](tg://user?id=${telegramId})`;
  } catch (err) {
    console.error(
      `[scheduler] Không lấy được thông tin thành viên ${telegramId} trong nhóm (có thể họ chưa từng nhắn gì trong nhóm, hoặc không còn trong nhóm):`,
      err.message
    );
    return `[${escapeMarkdown(fallbackName)}](tg://user?id=${telegramId})`;
  }
}

async function checkDeadline(bot, entryId) {
  let missedEntry = null;
  await updateTodayPlan((plan) => {
    const entry = plan.checkins.find((c) => c.id === entryId);
    if (!entry || entry.status !== 'pending') return plan; // da diem danh roi thi thoi, hoac entry khong ton tai
    entry.status = 'missed';
    missedEntry = entry;
    return plan;
  });

  if (!missedEntry) return;

  await appendAttendanceLog({
    telegramId: missedEntry.telegramId,
    name: missedEntry.name,
    scheduledTime: new Date(missedEntry.time).toISOString(),
    status: 'missed',
    respondedAt: null,
  });

  if (GROUP_CHAT_ID) {
    const timeStr = formatLocalTime(missedEntry.time, missedEntry.location);
    const mention = await resolveMention(bot, missedEntry.telegramId, missedEntry.name);
    try {
      await bot.telegram.sendMessage(
        GROUP_CHAT_ID,
        `⚠️ ${mention} (ID: ${missedEntry.telegramId}) CHƯA ĐIỂM DANH cho mốc ${timeStr}.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[scheduler] Không gửi được cảnh báo lên nhóm:', err.message);
    }
  }
}

// Goi khi co ai do gui anh - danh dau diem danh thanh cong neu dang co yeu cau pending
async function markCheckinDone(telegramId, photoFileId) {
  let doneEntry = null;
  await updateTodayPlan((plan) => {
    const entry = plan.checkins
      .filter((c) => c.telegramId === String(telegramId) && c.status === 'pending')
      .sort((a, b) => a.time - b.time)[0];
    if (!entry) return plan;

    entry.status = 'done';
    entry.respondedAt = Date.now();
    entry.photoFileId = photoFileId;
    doneEntry = entry;
    return plan;
  });

  if (!doneEntry) return null;

  await appendAttendanceLog({
    telegramId: doneEntry.telegramId,
    name: doneEntry.name,
    scheduledTime: new Date(doneEntry.time).toISOString(),
    status: 'done',
    respondedAt: new Date(doneEntry.respondedAt).toISOString(),
  });

  return doneEntry;
}

// Don entry qua cu (planDate hon 2 ngay truoc) de file khong phinh to theo thoi gian.
// Lich su day du van con nguyen trong attendance_log.json.
function pruneOldEntries(plan) {
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  plan.checkins = plan.checkins.filter((c) => c.time > cutoff);
  return plan;
}

// Kiem tra tung nhan vien: neu CHUA duoc lap lich cho ngay hien tai (theo mui gio rieng cua ho),
// thi tao moc diem danh ngau nhien moi va lich cho ho. Cho phep nhieu khu vuc/mui gio khac nhau
// "sang ngay moi" vao thoi diem khac nhau ma khong bi sot ai.
async function ensureAllShiftsPlanned(bot) {
  const shiftsData = getShifts(); // { month, employees } | null

  let addedEntries = [];
  await updateTodayPlan((plan) => {
    plan = pruneOldEntries(plan);
    if (!shiftsData || !shiftsData.employees) return plan;

    Object.values(shiftsData.employees).forEach((shift) => {
      const { todayStr, entries } = planForShift(shift, shiftsData.month);
      const alreadyPlanned = plan.checkins.some(
        (c) => c.telegramId === shift.telegramId && c.planDate === todayStr
      );
      if (alreadyPlanned || entries.length === 0) return;

      plan.checkins.push(...entries);
      addedEntries.push(...entries);
    });

    return plan;
  });

  addedEntries.forEach((entry) => scheduleCheckin(bot, entry));
  if (addedEntries.length > 0) {
    console.log(`[scheduler] Đã thêm lịch ${addedEntries.length} lượt điểm danh mới.`);
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
  formatLocalTime,
};
