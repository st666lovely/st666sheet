const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function readJson(name, fallback) {
  ensureDataDir();
  const p = filePath(name);
  if (!fs.existsSync(p)) return fallback;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[storage] Lỗi đọc ${name}:`, err.message);
    return fallback;
  }
}

function writeJson(name, data) {
  ensureDataDir();
  const p = filePath(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p); // ghi an toàn, tránh hỏng file nếu process bị kill giữa chừng
}

// ---- Shifts (lich lam viec theo thang) ----
// shape: { month: 'YYYY-MM', employees: { [telegramId]: { telegramId, name, location, daily: { [dayOfMonth]: {start,end}|null } } } }
function getShifts() {
  return readJson('shifts.json', null);
}
function saveShifts(shifts) {
  writeJson('shifts.json', shifts);
}

// ---- Lịch điểm danh hôm nay (để reschedule lại nếu server restart) ----
// shape: { date: 'YYYY-MM-DD', checkins: [{ id, telegramId, time, status, respondedAt, photoFileId }] }
function getTodayPlan() {
  return readJson('today_plan.json', null);
}
function saveTodayPlan(plan) {
  writeJson('today_plan.json', plan);
}

// ---- Log toàn bộ lịch sử điểm danh (để làm báo cáo) ----
function appendAttendanceLog(entry) {
  const log = readJson('attendance_log.json', []);
  log.push(entry);
  writeJson('attendance_log.json', log);
}
function getAttendanceLog() {
  return readJson('attendance_log.json', []);
}

module.exports = {
  getShifts,
  saveShifts,
  getTodayPlan,
  saveTodayPlan,
  appendAttendanceLog,
  getAttendanceLog,
};
