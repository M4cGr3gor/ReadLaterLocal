// One popup, two buttons:
//  - address-bar button (?mode=save): saves the tab and shows a small notice that closes itself
//  - toolbar button (?mode=list): the last 10 items, without saving (with a "Save this page" button)
import * as db from '../lib/db.js';
import { applyTheme } from '../lib/theme.js';
import { applyI18n, initI18n, t, uiLocale } from '../lib/i18n.js';
import { formatDate, hostOf } from '../lib/util.js';
import { saveTab, activeTab } from '../lib/save.js';
import { el, icon, thumbTile, titleOf, openListPage, openDataPage, readerUrl } from '../lib/ui.js';

const AUTO_CLOSE_MS = 1800;
const MODE = new URLSearchParams(location.search).get('mode') === 'save' ? 'save' : 'list';
if (MODE === 'list') document.body.classList.remove('mini');
const statusBox = document.getElementById('status');
const list = document.getElementById('recent');
const empty = document.getElementById('empty');
let newId = null;

// ---- auto-close for the small notice (paused while the mouse is over it) ----
let closeTimer = null;
let autoClose = false;
function scheduleClose(ms = AUTO_CLOSE_MS) {
  clearTimeout(closeTimer);
  if (autoClose) closeTimer = setTimeout(() => window.close(), ms);
}
document.addEventListener('mouseenter', () => clearTimeout(closeTimer));
document.addEventListener('mouseleave', () => scheduleClose(1200));

function showStatus(kind, text, ...actions) {
  statusBox.className = `status ${kind}`;
  statusBox.replaceChildren(icon(kind === 'ok' ? 'check' : 'info'), el('span', { class: 'status-text' }, text));
  for (const a of actions) statusBox.append(el('button', { class: a.primary ? 'btn-save' : 'link', type: 'button', onclick: a.run }, a.label));
  statusBox.hidden = false;
}

// Labels read lazily: the chosen language is loaded further down.
const seeRecent = { get label() { return t('seeRecent'); }, run: () => showList() };

// The background keeps working even if this popup closes.
function requestArticle(tab, item) {
  if (item.hasArticle || item.fetchState === 2) return;
  browser.runtime.sendMessage({ type: 'extract-article', tabId: tab.id, id: item.id, url: tab.url }).catch(() => {});
}

async function saveCurrentTab({ inList = false } = {}) {
  const tab = await activeTab();
  const res = await saveTab(tab);
  const more = inList ? [] : [seeRecent];
  if (res.status === 'unsavable') return showStatus('warn', t('cantSave'), ...more);
  newId = res.item.id;
  requestArticle(tab, res.item);
  if (res.status === 'existed') return showStatus('info', t('alreadySaved'), ...more);
  showStatus('ok', t('saved'), {
    label: t('undo'),
    run: async () => {
      clearTimeout(closeTimer);
      await db.deleteItem(res.item.id);
      newId = null;
      if (inList) { await renderRecent(); return showCurrentPageState(); }
      showStatus('info', t('saveRemoved'));
      scheduleClose(1200);
    },
  }, ...more);
  if (inList) renderRecent();
}

// List mode: tell whether the current page is saved, or offer to save it.
async function showCurrentPageState() {
  const tab = await activeTab();
  const existing = tab?.url ? await db.getByUrl(tab.url) : null;
  if (existing) {
    newId = existing.id;
    return showStatus('info', t('alreadySaved'));
  }
  if (!/^https?:/.test(tab?.url || '')) { statusBox.hidden = true; return; }
  showStatus('info', titleOf({ title: tab.title, url: tab.url }), {
    label: t('saveThisPage'), primary: true, run: () => saveCurrentTab({ inList: true }),
  });
}

function rowFor(item) {
  const archived = item.status === 'archive';
  const openUrl = url => { browser.tabs.create({ url }); window.close(); };
  const act = (name, label, fn, cls = '') => el('button', {
    class: `icon-btn ${cls}`, type: 'button', title: label, 'aria-label': label,
    onclick: async e => { e.stopPropagation(); await fn(); renderRecent(); },
  }, icon(name));
  return el('li', {
    class: `row${item.id === newId ? ' new' : ''}${archived ? ' archived' : ''}`,
    tabindex: '0', title: item.url,
    onclick: () => openUrl(item.url),
    onkeydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) openUrl(item.url); },
  },
    thumbTile(item),
    el('div', { class: 'row-text' },
      el('div', { class: 'row-title', dir: 'auto' }, titleOf(item)),
      el('div', { class: 'row-meta' }, `${hostOf(item.url)} · ${formatDate(item.time_added, uiLocale())}`)),
    el('div', { class: 'row-actions' },
      // The reader downloads the text on the spot if it isn't saved yet.
      act('book', t('reader'), () => openUrl(readerUrl(item.id))),
      archived
        ? act('unarchive', t('unarchive'), () => db.updateItem(item.id, { status: 'unread' }))
        : act('archive', t('archive'), () => db.updateItem(item.id, { status: 'archive' })),
      act('trash', t('delete'), () => db.moveToTrash([item.id], 'manual'), 'danger')),
  );
}

async function renderRecent() {
  const items = await db.recent(10);
  list.replaceChildren(...items.map(rowFor));
  empty.hidden = items.length > 0;
}

// Switch from the small notice to the full list.
async function showList() {
  autoClose = false;
  clearTimeout(closeTimer);
  document.body.classList.remove('mini');
  for (const b of statusBox.querySelectorAll('button')) if (b.textContent === seeRecent.label) b.remove();
  await renderRecent();
}

function wireFooter() {
  document.getElementById('export').append(icon('download'));
  document.getElementById('import').append(icon('upload'));
  document.getElementById('data').append(icon('settings'));
  const go = fn => async () => { await fn(); window.close(); };
  document.getElementById('view-all').addEventListener('click', go(() => openListPage('')));
  document.getElementById('export').addEventListener('click', go(() => openListPage('#export')));
  document.getElementById('import').addEventListener('click', go(() => openListPage('#import')));
  document.getElementById('data').addEventListener('click', go(() => openDataPage('')));
}

await Promise.all([initI18n(), applyTheme()]);
applyI18n();
wireFooter();
if (MODE === 'list') {
  showCurrentPageState().catch(console.error);
  renderRecent();
} else {
  autoClose = true;
  saveCurrentTab()
    .catch(err => { console.error(err); showStatus('warn', String(err.message || err)); })
    .finally(() => scheduleClose());
}
