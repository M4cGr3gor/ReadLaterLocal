// DOM helpers shared by the popup, the list, the reader and the data page.
import { getFavicon, getThumb } from './db.js';
import { colorForHost, displayTitle, hostOf } from './util.js';
import { youtubeId, youtubeThumbUrl } from './classify.js';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

// Inline SVG icons (no external fonts: keeps the extension self-contained).
const ICONS = {
  archive: 'M4 7h16M5 7v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M3 4h18v3H3zM10 11h4',
  unarchive: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  external: 'M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6M11 13l9-9M15 4h5v5',
  download: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5 5-5M12 4v12',
  upload: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 9l5-5 5 5M12 4v12',
  list: 'M9 6h11M9 12h11M9 18h11M5 6v.01M5 12v.01M5 18v.01',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  check: 'M5 12l5 5L20 7',
  search: 'M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M21 21l-6-6',
  info: 'M12 9h.01M11 12h1v4h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  star: 'M12 17.75l-6.17 3.24 1.18-6.87-5-4.86 6.9-1 3.09-6.26 3.09 6.26 6.9 1-5 4.86 1.18 6.87z',
  tag: 'M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0M3 6v5.17a2 2 0 0 0 .59 1.42l7.71 7.71a2.41 2.41 0 0 0 3.4 0l5.6-5.6a2.41 2.41 0 0 0 0-3.4L12.59 3.59A2 2 0 0 0 11.17 3H6a3 3 0 0 0-3 3z',
  book: 'M3 19a9 9 0 0 1 9 0 9 9 0 0 1 9 0M3 6a9 9 0 0 1 9 0 9 9 0 0 1 9 0M3 6v13M12 6v13M21 6v13',
  settings: 'M10.3 4.3c.4-1.8 3-1.8 3.4 0a1.7 1.7 0 0 0 2.6 1.1c1.5-.9 3.3.8 2.4 2.4a1.7 1.7 0 0 0 1 2.5c1.8.4 1.8 3 0 3.4a1.7 1.7 0 0 0-1 2.6c.9 1.5-.9 3.3-2.4 2.4a1.7 1.7 0 0 0-2.6 1c-.4 1.8-3 1.8-3.4 0a1.7 1.7 0 0 0-2.6-1c-1.5.9-3.3-.9-2.4-2.4a1.7 1.7 0 0 0-1-2.6c-1.8-.4-1.8-3 0-3.4a1.7 1.7 0 0 0 1-2.6c-.9-1.5.9-3.3 2.4-2.4a1.7 1.7 0 0 0 2.6-1zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  chevron: 'M6 9l6 6 6-6',
  clock: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 3',
  note: 'M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h3',
  folder: 'M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  dice: 'M4 4h16v16H4zM8.5 8.5h.01M15.5 15.5h.01M12 12h.01M15.5 8.5h.01M8.5 15.5h.01',
  select: 'M4 4h16v16H4zM8 12l3 3 5-6',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  globe: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18',
  gridSmall: 'M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4zM16 16h4v4h-4z',
  gridMedium: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  gridLarge: 'M4 4h16v12H4zM4 19h16',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  printer: 'M7 9V3h10v6M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z',
  highlight: 'M9 15l-3 3h-3l1.5-1.5M9 15l-2-2 9-9a2 2 0 0 1 3 0l1 1a2 2 0 0 1 0 3l-9 9zM13 7l4 4M3 21h18',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  broom: 'M14 4l6 6M16 6l-5 5M11 11l-6 1-2 9 9-2 1-6zM7 15l-3 3M9 17l-2 2',
  speaker: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12',
  play: 'M7 4.5l12 7.5-12 7.5z',
  pause: 'M8 5v14M16 5v14',
  prev: 'M18 6l-8 6 8 6zM6 6v12',
  next: 'M6 6l8 6-8 6zM18 6v12',
  stop: 'M6 6h12v12H6z',
  markdown: 'M3 6h18v12H3zM6 15V9l2.5 3L11 9v6M16 9v6M13.5 12.5L16 15l2.5-2.5',
  hourglass:'M6 3h12M6 21h12M8 3v3l4 6-4 6v3M16 3v3l-4 6 4 6v3',
};

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

const faviconCache = new Map();
export function faviconFor(host) {
  if (!faviconCache.has(host)) faviconCache.set(host, getFavicon(host).catch(() => null));
  return faviconCache.get(host);
}

// Picture for an item: placeholder tile right away, thumbnail (or site icon) once loaded.
/**
 * The picture of an item. `from` is the tile it replaces when a card is redrawn: its picture
 * is kept until the new one has loaded, so updates don't blink.
 */
export function thumbTile(item, { lazy = false, from = null } = {}) {
  const host = hostOf(item.url);
  const tile = el('div', { class: `thumb c${colorForHost(host)}` });
  if (from?.firstChild) tile.append(...from.childNodes);
  else tile.append(el('span', { class: 'thumb-letter' }, (host[0] || '?').toUpperCase()));
  const show = img => new Promise(resolve => {
    img.addEventListener('load', () => { tile.replaceChildren(img); resolve(); }, { once: true });
    img.addEventListener('error', resolve, { once: true });
  });
  const load = async () => {
    const blob = await getThumb(item.id);
    if (blob) {
      const url = URL.createObjectURL(blob);
      await show(el('img', { class: 'thumb-img', alt: '', src: url }));
      URL.revokeObjectURL(url);
      return;
    }
    // YouTube thumbnails have a fixed address: show it straight from YouTube when there's no
    // local copy (it's saved locally once the site-access permission is granted).
    const yt = youtubeId(item.url);
    if (yt) {
      const img = el('img', { class: 'thumb-img center', alt: '', src: youtubeThumbUrl(yt), referrerpolicy: 'no-referrer' });
      img.addEventListener('load', () => tile.replaceChildren(img), { once: true });
      return;
    }
    const fav = await faviconFor(host);
    if (fav) await show(el('img', { class: 'thumb-favicon', src: fav, alt: '' }));
  };
  if (lazy) {
    tile.dataset.lazy = '1';
    tile._load = load;
  } else {
    load();
  }
  return tile;
}

export function titleOf(item) {
  return displayTitle(item);
}

export function toast(container, message, action) {
  container.replaceChildren();
  const box = el('div', { class: 'toast', role: 'status' }, el('span', {}, message));
  if (action) box.append(el('button', { class: 'link', type: 'button', onclick: () => { action.run(); box.remove(); } }, action.label));
  container.append(box);
  clearTimeout(container._timer);
  container._timer = setTimeout(() => box.remove(), action ? 6000 : 4000);
}

// Open an extension page, reusing an existing tab of it if there is one.
async function openPage(path, hash = '') {
  const base = browser.runtime.getURL(path);
  const tabs = await browser.tabs.query({ url: base + '*' }).catch(() => []);
  if (tabs.length) {
    await browser.tabs.update(tabs[0].id, { active: true, url: base + hash });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: base + hash });
  }
}

export const openListPage = (hash = '') => openPage('list/list.html', hash);
export const openDataPage = (hash = '') => openPage('options/options.html', hash);

export function readerUrl(id) {
  return browser.runtime.getURL(`reader/reader.html?id=${id}`);
}

export function formatBytes(n, locale) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString(locale, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}
