// Pure helpers shared by the popup, the list page and the background script.

export function isSavableUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// When Pocket had no title it stored the url itself; show "host/path" instead.
export function displayTitle(rec) {
  const title = (rec.title || '').trim();
  if (title && title !== rec.url) return title;
  try {
    const u = new URL(rec.url);
    const path = (u.pathname + u.search).replace(/\/$/, '');
    return u.hostname.replace(/^www\./, '') + path;
  } catch {
    return rec.url;
  }
}

export const TILE_COLORS = 8;

export function colorForHost(host) {
  let h = 0;
  for (const ch of String(host)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % TILE_COLORS;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function formatDate(sec, locale) {
  const d = new Date(sec * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

// Tags are stored as a lowercase array; Pocket's CSV uses "a|b".
export function normalizeTags(input) {
  const parts = Array.isArray(input) ? input : String(input ?? '').split(/[,|]/);
  const out = [];
  for (const p of parts) {
    const tag = String(p).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// "guía tag:css site:github.com flexbox" -> { text: 'guia flexbox', tags: ['css'], sites: ['github.com'] }
export function parseQuery(q) {
  const tags = [];
  const sites = [];
  const words = [];
  for (const token of String(q ?? '').trim().split(/\s+/)) {
    if (!token) continue;
    const t = /^tag:(.+)$/i.exec(token);
    const s = /^site:(.+)$/i.exec(token);
    if (t) tags.push(...normalizeTags(t[1]));
    else if (s) sites.push(s[1].toLowerCase().replace(/^www\./, ''));
    else words.push(token);
  }
  return { text: normalize(words.join(' ')), tags, sites };
}

export function matchesQuery(item, { text, tags, sites = [] }) {
  if (tags.length) {
    const own = item.tags || [];
    if (!tags.every(t => own.includes(t))) return false;
  }
  if (sites.length) {
    const host = hostOf(item.url);
    if (!sites.some(s => host === s || host.endsWith('.' + s))) return false;
  }
  return !text || normalize(item.title + ' ' + item.url + ' ' + (item.note || '')).includes(text);
}
