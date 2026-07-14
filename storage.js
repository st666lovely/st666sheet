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

// Cap nhat today_plan.json AN TOAN khi co nhieu thao tac doc-sua-ghi xay ra gan nhau
// (vd nhieu nguoi cung duoc gui yeu cau diem danh, hoac vua gui yeu cau vua co nguoi reply anh cung luc).
// Neu khong co co che nay, 2 thao tac doc-sua-ghi chong cheo co the lam MAT du lieu cua nhau
// (thao tac ghi sau de len ban doc cu, xoa mat thay doi cua thao tac truoc).
// Dua toan bo cac lan doc-sua-ghi vao 1 hang doi tuan tu (chi 1 luc chay 1 lan) de tranh mat du lieu.
let planQueue = Promise.resolve();
function updateTodayPlan(mutator) {
  const task = planQueue.then(() => {
    const plan = readJson('today_plan.json', { checkins: [] }) || { checkins: [] };
    const result = mutator(plan);
    const finalPlan = result || plan;
    writeJson('today_plan.json', finalPlan);
    return finalPlan;
  });
  // giu hang doi song ngay ca khi 1 buoc bi loi, khong lam ket hang doi vinh vien
  planQueue = task.catch(() => {});
  return task;
}

// ---- Log toàn bộ lịch sử điểm danh (để làm báo cáo) ----
// Cung dung hang doi tuan tu nhu tren de tranh mat dong log khi nhieu nguoi diem danh gan nhau
let logQueue = Promise.resolve();
function appendAttendanceLog(entry) {
  const task = logQueue.then(() => {
    const log = readJson('attendance_log.json', []);
    log.push(entry);
    writeJson('attendance_log.json', log);
  });
  logQueue = task.catch(() => {});
  return task;
}
function getAttendanceLog() {
  return readJson('attendance_log.json', []);
}

module.exports = {
  getShifts,
  saveShifts,
  getTodayPlan,
  saveTodayPlan,
  updateTodayPlan,
  appendAttendanceLog,
  getAttendanceLog,
};
