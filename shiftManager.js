const XLSX = require('xlsx');
const { getShifts, saveShifts } = require('./storage');

// Map các tên cột có thể gặp (không phân biệt hoa thường, có dấu/không dấu) -> field chuẩn
const HEADER_ALIASES = {
  telegramid: 'telegramId',
  telegram_id: 'telegramId',
  id: 'telegramId',
  ten: 'name',
  name: 'name',
  hoten: 'name',
  khuvuc: 'location',
  location: 'location',
  chinhanh: 'location',
  giobatdau: 'shiftStart',
  gio_bat_dau: 'shiftStart',
  bắtđầu: 'shiftStart',
  shiftstart: 'shiftStart',
  giokêtthúc: 'shiftEnd',
  gioketthuc: 'shiftEnd',
  shiftend: 'shiftEnd',
  ngaylam: 'days',
  ngày: 'days',
  days: 'days',
};

function normalizeHeader(h) {
  const key = String(h)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // bỏ dấu tiếng Việt
    .replace(/\s+/g, '');
  return HEADER_ALIASES[key] || key;
}

// "T2-T6" -> [1,2,3,4,5], "T2,T3,T5" -> [1,2,3,5], "1,2,3,4,5" -> [1,2,3,4,5]
// Quy ước: CN=0, T2=1, T3=2, T4=3, T5=4, T6=5, T7=6
function parseDays(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [1, 2, 3, 4, 5, 6, 0]; // mặc định: làm cả tuần nếu không ghi gì
  }
  const str = String(raw).trim().toUpperCase();
  const dayCode = (token) => {
    token = token.trim();
    if (token === 'CN') return 0;
    const m = token.match(/^T(\d)$/);
    if (m) return parseInt(m[1], 10) - 1;
    const n = parseInt(token, 10);
    return isNaN(n) ? null : n;
  };

  if (str.includes('-')) {
    const [start, end] = str.split('-').map(dayCode);
    if (start === null || end === null) return [1, 2, 3, 4, 5, 6, 0];
    const days = [];
    let d = start;
    while (true) {
      days.push(d);
      if (d === end) break;
      d = (d + 1) % 7;
    }
    return days;
  }
  return str
    .split(',')
    .map(dayCode)
    .filter((d) => d !== null);
}

function parseTime(raw) {
  // hỗ trợ "08:00", "8:00", 0.333 (excel time serial), "8h00"
  if (typeof raw === 'number') {
    // excel lưu giờ dạng phân số của 1 ngày
    const totalMinutes = Math.round(raw * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const str = String(raw).trim().replace('h', ':').replace('H', ':');
  const m = str.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * Đọc file excel/csv và trả về { shifts, errors, count }
 * Không tự lưu - để caller quyết định merge hay ghi đè
 */
function parseShiftFile(filePathOnDisk) {
  const workbook = XLSX.readFile(filePathOnDisk);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const shifts = {};
  const errors = [];

  rows.forEach((row, idx) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[normalizeHeader(key)] = value;
    }

    const telegramId = String(normalized.telegramId || '').trim();
    const name = String(normalized.name || '').trim();
    const shiftStart = parseTime(normalized.shiftStart);
    const shiftEnd = parseTime(normalized.shiftEnd);

    if (!telegramId) {
      errors.push(`Dòng ${idx + 2}: thiếu TelegramID, đã bỏ qua.`);
      return;
    }
    if (!shiftStart || !shiftEnd) {
      errors.push(`Dòng ${idx + 2} (${name || telegramId}): giờ ca không hợp lệ, đã bỏ qua.`);
      return;
    }

    shifts[telegramId] = {
      telegramId,
      name: name || telegramId,
      location: String(normalized.location || '').trim(),
      shiftStart,
      shiftEnd,
      days: parseDays(normalized.days),
    };
  });

  return { shifts, errors, count: Object.keys(shifts).length };
}

// Merge = cập nhật/thêm mới, giữ lại người không có trong file mới
function mergeAndSaveShifts(newShifts) {
  const current = getShifts();
  const merged = { ...current, ...newShifts };
  saveShifts(merged);
  return merged;
}

// Ghi đè hoàn toàn danh sách cũ bằng file mới
function replaceAndSaveShifts(newShifts) {
  saveShifts(newShifts);
  return newShifts;
}

module.exports = {
  parseShiftFile,
  mergeAndSaveShifts,
  replaceAndSaveShifts,
};
