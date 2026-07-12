const XLSX = require('xlsx');
const { getShifts, saveShifts } = require('./storage');

// Cac ten cot co dinh o dau bang (khong phan biet hoa thuong, co dau/khong dau)
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
};

function normalizeHeader(h) {
  return String(h)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // bo dau tieng Viet
    .replace(/\s+/g, '');
}

const OFF_TOKENS = new Set(['off', 'nghi', 'nghỉ', 'x', '-', 'nn']);

// Nhan 1 o gio ca dang "12:00-22:00", "12h00-22h00", "8:00 - 16:00" -> { start, end }
// Tra ve null neu khong parse duoc (coi nhu loi, KHONG phai ngay nghi)
function parseTimeRangeCell(raw) {
  const str = String(raw).trim();
  if (!str) return { off: true };
  const normalized = normalizeHeader(str);
  if (OFF_TOKENS.has(normalized)) return { off: true };

  const cleaned = str.replace(/h/gi, ':');
  const m = cleaned.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null; // loi dinh dang, khong xac dinh duoc

  const start = `${m[1].padStart(2, '0')}:${m[2]}`;
  const end = `${m[3].padStart(2, '0')}:${m[4]}`;
  return { off: false, start, end };
}

/**
 * Doc file excel/csv dang BANG LICH THANG:
 * cot dau: TelegramID | Ten | KhuVuc
 * cac cot sau: so ngay trong thang (1, 2, 3, ... 31), moi o ghi "HH:mm-HH:mm" hoac de trong/"OFF" neu nghi
 *
 * monthStr: 'YYYY-MM' - thang ma lich nay ap dung (lay tu caption luc upload)
 * Tra ve { month, employees, errors, count } - khong tu luu, de caller quyet dinh merge/ghi de
 */
function parseShiftFile(filePathOnDisk, monthStr) {
  const workbook = XLSX.readFile(filePathOnDisk);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const errors = [];
  if (rows.length < 2) {
    return { month: monthStr, employees: {}, errors: ['File rỗng hoặc thiếu dữ liệu.'], count: 0 };
  }

  const headerRow = rows[0];
  const colMap = {}; // index -> 'telegramId' | 'name' | 'location'
  const dayCols = []; // { index, day }

  headerRow.forEach((h, idx) => {
    const norm = normalizeHeader(h);
    if (HEADER_ALIASES[norm]) {
      colMap[idx] = HEADER_ALIASES[norm];
      return;
    }
    const asNum = parseInt(String(h).trim(), 10);
    if (!isNaN(asNum) && asNum >= 1 && asNum <= 31 && String(asNum) === String(h).trim()) {
      dayCols.push({ index: idx, day: asNum });
    }
  });

  if (!Object.values(colMap).includes('telegramId')) {
    return {
      month: monthStr,
      employees: {},
      errors: ['Không tìm thấy cột TelegramID trong file. Kiểm tra lại tiêu đề cột.'],
      count: 0,
    };
  }
  if (dayCols.length === 0) {
    return {
      month: monthStr,
      employees: {},
      errors: ['Không tìm thấy cột ngày nào (1, 2, 3, ... 31) trong file.'],
      count: 0,
    };
  }

  const employees = {};

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => String(c).trim() === '')) continue; // dong trong, bo qua

    let telegramId = '';
    let name = '';
    let location = '';
    Object.entries(colMap).forEach(([idx, field]) => {
      const val = String(row[idx] ?? '').trim();
      if (field === 'telegramId') telegramId = val;
      if (field === 'name') name = val;
      if (field === 'location') location = val;
    });

    if (!telegramId) {
      errors.push(`Dòng ${r + 1}: thiếu TelegramID, đã bỏ qua.`);
      continue;
    }

    const daily = {};
    let rowHasError = false;
    dayCols.forEach(({ index, day }) => {
      const cellRaw = row[index];
      const parsed = parseTimeRangeCell(cellRaw);
      if (parsed === null) {
        errors.push(
          `Dòng ${r + 1} (${name || telegramId}), ngày ${day}: định dạng giờ "${cellRaw}" không đọc được, đã coi là nghỉ.`
        );
        rowHasError = true;
        daily[day] = null;
        return;
      }
      daily[day] = parsed.off ? null : { start: parsed.start, end: parsed.end };
    });

    employees[telegramId] = {
      telegramId,
      name: name || telegramId,
      location: location || '',
      daily,
    };
  }

  return { month: monthStr, employees, errors, count: Object.keys(employees).length };
}

// Merge: neu cung thang -> gop theo tung nhan vien (nguoi khong co trong file moi giu nguyen lich cu).
// Neu khac thang -> khong the gop (cau truc ngay khac nhau giua cac thang), tu dong chuyen sang thang moi hoan toan.
function mergeAndSaveShifts(newData) {
  const current = getShifts(); // { month, employees } | null
  if (!current || current.month !== newData.month) {
    saveShifts(newData);
    return newData;
  }
  const mergedEmployees = { ...current.employees, ...newData.employees };
  const merged = { month: newData.month, employees: mergedEmployees };
  saveShifts(merged);
  return merged;
}

// Ghi de hoan toan danh sach cu bang file moi (bat ke cung thang hay khac thang)
function replaceAndSaveShifts(newData) {
  saveShifts(newData);
  return newData;
}

module.exports = {
  parseShiftFile,
  mergeAndSaveShifts,
  replaceAndSaveShifts,
};
