// CSV import/export compatible with Pocket's export: title,url,time_added,tags,status
import { isSavableUrl, normalizeTags, nowSeconds } from './util.js';

export const CSV_COLUMNS = ['title', 'url', 'time_added', 'tags', 'status', 'favorite'];

// RFC 4180 parser: quoted fields may contain commas, "" escapes and newlines.
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

export function rowsToRecords(rows) {
  if (!rows.length) return { records: [], invalid: 0 };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = Object.fromEntries(CSV_COLUMNS.map(c => [c, header.indexOf(c)]));
  const get = (r, c) => (idx[c] >= 0 ? (r[idx[c]] ?? '') : '');
  const records = [];
  let invalid = 0;
  for (const r of rows.slice(1)) {
    const url = get(r, 'url').trim();
    if (!isSavableUrl(url)) { invalid++; continue; }
    const t = parseInt(get(r, 'time_added'), 10);
    const status = get(r, 'status').trim().toLowerCase();
    records.push({
      title: get(r, 'title').trim() || url,
      url,
      time_added: Number.isFinite(t) && t > 0 ? t : nowSeconds(),
      tags: normalizeTags(get(r, 'tags')),
      status: status === 'archive' ? 'archive' : 'unread',
      favorite: ['1', 'true', 'yes'].includes(get(r, 'favorite').trim().toLowerCase()) ? 1 : 0,
    });
  }
  return { records, invalid };
}

function escapeField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function recordsToCsv(records) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of records) {
    const row = { ...r, tags: (r.tags || []).join('|'), favorite: r.favorite ? 1 : 0 };
    lines.push(CSV_COLUMNS.map(c => escapeField(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}
