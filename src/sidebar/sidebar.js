// Sidebar: the reading list next to the page. Click opens an item in the current tab,
// Ctrl+click (or middle click) in a new tab.
import * as db from '../lib/db.js';
import { applyTheme } from '../lib/theme.js';
import { applyI18n, initI18n, t, uiLocale } from '../lib/i18n.js';
import { formatDate, hostOf, isSavableUrl } from '../lib/util.js';
import { readingMinutes } from '../lib/classify.js';
import { saveTab } from '../lib/save.js';
import { hasSitePermission } from '../lib/fetcher.js';
import { el, icon, thumbTile, titleOf, toast, readerUrl, openListPage } from '../lib/ui.js';

const PAGE_SIZE = 40;
const $ = id => document.getElementById(id);
const listEl = $('items');
const toasts = $('toasts');
const state = { status: 'unread', query: '', next: null, done: false, loading: false, generation: 0 };

// ---- opening: current tab, or a new one with Ctrl / Cmd / middle click ----
async function currentTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function open(url, e) {
  if (e.ctrlKey || e.metaKey || e.button === 1) {
    await browser.tabs.create({ url, active: !e.shiftKey });
    return;
  }
  const tab = await currentTab();
  if (tab) await browser.tabs.update(tab.id, { url });
  else await browser.tabs.create({ url });
}

// Thumbnails load only when their row scrolls into view.
const thumbObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    e.target._load?.();
  }
}, { rootMargin: '200px' });
const observeThumb = tile => { thumbObserver.observe(tile); return tile; };
// A row that leaves the page must not stay referenced by the observer.
const forgetThumb = row => { const tile = row.querySelector('.thumb'); if (tile) thumbObserver.unobserve(tile); };

function rowFor(item, old = null) {
  const archived = item.status === 'archive';
  const minutes = readingMinutes(item.words);
  const act = (name, label, fn, cls = '') => el('button', {
    class: `icon-btn ${cls}`, type: 'button', title: label, 'aria-label': label,
    onclick: e => { e.stopPropagation(); fn(e); },
    onauxclick: e => { e.stopPropagation(); if (e.button === 1) fn(e); },
  }, icon(name));
  const row = el('li', { class: `row${archived ? ' archived' : ''}`, tabindex: '0', title: `${item.url}\n${t('sidebarHint')}`, dataset: { id: item.id } },
    observeThumb(thumbTile(item, { lazy: true, from: old?.querySelector('.thumb') })),
    el('div', { class: 'row-text' },
      el('div', { class: 'row-title', dir: 'auto' }, titleOf(item)),
      el('div', { class: 'row-meta' },
        item.favorite ? el('span', { class: 'fav' }, '★ ') : null,
        `${hostOf(item.url)} · ${formatDate(item.time_added, uiLocale())}${minutes ? ' · ' + t('minutes', [String(minutes)]) : ''}`)),
    el('div', { class: 'row-actions' },
      act('book', t('reader'), e => open(readerUrl(item.id), e)),
      archived
        ? act('unarchive', t('unarchive'), () => change(item, { status: 'unread' }, 'movedToUnread'))
        : act('archive', t('archive'), () => change(item, { status: 'archive' }, 'archived')),
      act('trash', t('delete'), () => trash(item), 'danger')));
  row._item = item;
  row.addEventListener('click', e => open(item.url, e));
  row.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); open(item.url, e); } });
  row.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === row) open(item.url, e); });
  return row;
}

// Own changes don't come back as messages: refresh the touched row directly.
function refreshRow(id) {
  sync.ids.add(id);
  return applySync();
}

async function change(item, patch, message) {
  await db.updateItem(item.id, patch);
  toast(toasts, t(message));
  refreshRow(item.id);
}

async function trash(item) {
  const trashed = await db.trashItems([item.id]);
  refreshRow(item.id);
  toast(toasts, t('deleted'), { label: t('undo'), run: async () => { await db.undoTrash(trashed); reset(); } });
}

// ---- list with infinite scroll ----
async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  const gen = state.generation;
  try {
    const { items, next } = await db.page({ status: state.status, query: state.query, after: state.next, limit: PAGE_SIZE });
    if (gen !== state.generation) return;
    listEl.append(...items.map(item => rowFor(item)));
    state.next = next;
    state.done = !next;
  } finally {
    if (gen === state.generation) {
      state.loading = false;
      $('empty').hidden = !(state.done && !listEl.children.length);
      $('empty').textContent = state.query ? t('noResults') : t('emptyListTitle');
      if (!state.done && $('sentinel').getBoundingClientRect().top < innerHeight + 300) loadMore();
    }
  }
}

function reset() {
  state.generation++;
  state.next = null;
  state.done = false;
  state.loading = false;
  thumbObserver.disconnect(); // the old rows go: stop watching them
  listEl.replaceChildren();
  refreshCounts();
  loadMore();
}

async function refreshCounts() {
  const c = await db.counts();
  for (const span of document.querySelectorAll('[data-count]')) span.textContent = c[span.dataset.count];
}

new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) loadMore(); }, { rootMargin: '300px' }).observe($('sentinel'));

for (const chip of document.querySelectorAll('.chip[data-status]')) {
  chip.addEventListener('click', () => {
    state.status = chip.dataset.status;
    for (const c of document.querySelectorAll('.chip[data-status]')) c.setAttribute('aria-selected', String(c === chip));
    reset();
  });
}
let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = $('search').value; reset(); }, 200);
});

// ---- the page in the current tab: saved or not ----
async function refreshPageState() {
  const box = $('page-state');
  const tab = await currentTab();
  if (!tab || !isSavableUrl(tab.url)) { box.hidden = true; return; }
  const saved = await db.getByUrl(tab.url);
  box.hidden = false;
  box.className = `page-state${saved ? ' saved' : ''}`;
  if (saved) {
    box.replaceChildren(icon('check'), el('span', { class: 'label' }, t('alreadySaved')));
    return;
  }
  box.replaceChildren(el('span', { class: 'label', dir: 'auto', title: tab.title }, titleOf({ title: tab.title, url: tab.url })),
    el('button', { type: 'button', onclick: () => saveCurrent(tab) }, t('saveThisPage')));
}

async function saveCurrent(tab) {
  // Without site access the sidebar can't take a screenshot or read the article: the item is
  // saved anyway and the background download (or opening it in the reader) completes it.
  const res = await saveTab(tab);
  if (res.status === 'unsavable') return toast(toasts, t('cantSave'));
  if (res.status === 'saved' && (await hasSitePermission())) {
    browser.runtime.sendMessage({ type: 'extract-article', tabId: tab.id, id: res.item.id, url: tab.url }).catch(() => {});
  }
  toast(toasts, t(res.status === 'saved' ? 'saved' : 'alreadySaved'));
  refreshPageState();
  reset();
}

browser.tabs.onActivated.addListener(refreshPageState);
browser.tabs.onUpdated.addListener((id, info, tab) => { if (tab.active && (info.url || info.status === 'complete')) refreshPageState(); }, { properties: ['url', 'status'] });

// Changes made elsewhere (popup, "View all", reader, background).
// Rows are updated in place so the scroll position stays put; new items only pop in near the top.
const sync = { ids: new Set(), all: false, timer: 0 };
browser.runtime.onMessage.addListener(message => {
  if (message?.type !== 'items-changed') return;
  if (Array.isArray(message.ids)) for (const id of message.ids) sync.ids.add(id);
  else sync.all = true;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(applySync, 300);
});

const fitsFilter = item => state.status === 'all' || (state.status === 'favorite' ? !!item.favorite : item.status === state.status);

async function applySync() {
  const ids = [...sync.ids];
  const all = sync.all;
  sync.ids.clear();
  sync.all = false;
  refreshCounts();
  refreshPageState();
  const nearTop = document.scrollingElement.scrollTop < 100;
  let missing = false;
  for (const id of ids) {
    const row = listEl.querySelector(`.row[data-id="${id}"]`);
    const item = await db.getItem(id);
    if (!row) { if (item && fitsFilter(item)) missing = true; continue; }
    if (!item || !fitsFilter(item)) { forgetThumb(row); row.remove(); }
    // Background downloads touch items often: only redraw when something changed,
    // and keep the picture on screen meanwhile.
    else if (JSON.stringify(item) !== JSON.stringify(row._item)) { forgetThumb(row); row.replaceWith(rowFor(item, row)); }
  }
  if ((all || missing) && nearTop) reset();
}

$('view-all').addEventListener('click', () => openListPage(''));
$('search-icon').append(icon('search'));

await Promise.all([initI18n(), applyTheme()]);
applyI18n();
document.querySelector('.chip[data-status="unread"]').setAttribute('aria-selected', 'true');
refreshPageState();
reset();
