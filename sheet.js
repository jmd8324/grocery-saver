// Reading, writing and updating prices.csv.
// Shared by the price update page (update-prices.html) and the save function
// (api/save-prices.js), so both change the sheet in exactly the same way.

export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const data = rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
  return { header, rows: data };
}

export function toCSV({ header, rows }) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows.map((r) => header.map((h) => r[h]))].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

// A row is identified by item + brand + size, so updates still land on the
// right row even if rows were added or reordered since the photo was read.
export const rowKey = (r) => [r.item, r.brand, r.size].map((v) => String(v || '').trim().toLowerCase()).join('|');

// Price columns a photo can fill: the store columns and their "_member" columns.
export function priceColumns(header) {
  const fixed = new Set(['item', 'also_called', 'brand', 'size', 'checked_on', 'notes']);
  return header.filter((h) => !fixed.has(h));
}

// updates: [{ key, newRow?: { item, brand, size }, alsoCalled?, column, price, checkedOn }]
//   key     - rowKey of an existing row, or omitted with newRow to add a row
//   alsoCalled - other names to add to the row's also_called (e.g. "magic eraser; cleaner")
//   column  - e.g. "giant" or "giant_member"
//   price   - number like 3.99
// Returns { sheet, applied, skipped } and never modifies the input sheet.
// Adds names to a "a; b" list, skipping blanks, repeats and the item's own name.
export function mergeNames(existing, extra, item) {
  const out = String(existing || '').split(';').map((s) => s.trim()).filter(Boolean);
  const seen = new Set([...out.map((s) => s.toLowerCase()), String(item || '').trim().toLowerCase()]);
  const add = Array.isArray(extra) ? extra : String(extra || '').split(';');
  for (const raw of add) {
    const n = String(raw || '').replace(/[,;\r\n]+/g, ' ').trim().toLowerCase().slice(0, 60);
    if (n && !seen.has(n)) { out.push(n); seen.add(n); }
  }
  return out.join('; ');
}

export function applyUpdates(sheet, updates) {
  const header = [...sheet.header];
  const rows = sheet.rows.map((r) => ({ ...r }));
  const allowed = new Set(priceColumns(header));
  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  let applied = 0;
  const skipped = [];

  for (const u of updates || []) {
    const price = Number(u && u.price);
    if (!u || !allowed.has(u.column) || !(price > 0 && price < 10000)) { skipped.push(u); continue; }
    let row = u.key ? byKey.get(String(u.key)) : null;
    if (!row && u.newRow && String(u.newRow.item || '').trim()) {
      const candidate = Object.fromEntries(header.map((h) => [h, '']));
      candidate.item = String(u.newRow.item).trim().toLowerCase();
      candidate.brand = String(u.newRow.brand || '').trim();
      candidate.size = String(u.newRow.size || '').trim();
      const k = rowKey(candidate);
      row = byKey.get(k);
      if (!row) { rows.push(candidate); byKey.set(k, candidate); row = candidate; }
    }
    if (!row) { skipped.push(u); continue; }
    if (header.includes('also_called')) row.also_called = mergeNames(row.also_called, u.alsoCalled, row.item);
    row[u.column] = price.toFixed(2);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(u.checkedOn || '')) ? u.checkedOn : null;
    if (d && (!row.checked_on || d > row.checked_on)) row.checked_on = d;
    applied++;
  }
  return { sheet: { header, rows }, applied, skipped };
}
