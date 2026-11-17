// Background (event page):
//  - right-click on the toolbar button: save, last 10 saved, "View all", export, data
//  - right-click on a link or a page: save it without opening the popup
//  - saving the article text of the current tab (asked by the popup)
//  - "unread" counter on the toolbar button, and the address-bar icon showing "already saved"
//  - automatic backups when they're switched on and due
//  - automatic cleanup (rules and "delete in…" dates) when Firefox starts
import { addItem, getByUrl, recent, setArticle, unreadCount, updateItem } from './lib/db.js';
import { displayTitle, hostOf, isSavableUrl, nowSeconds } from './lib/util.js';
import { openDataPage, openListPage, faviconFor } from './lib/ui.js';
import { initI18n, t as msg } from './lib/i18n.js';
import { iconSet } from './lib/icons.js';

// Firefox wakes this page for every tab that loads. Modules only needed now and then (saving,
// backups, cleanup, pictures) are loaded when they're used, so each wake-up stays light.
const lazy = {
  article: () => import('./lib/article.js'),
  backup: () => import('./lib/autobackup.js'),
  cleanup: () => import('./lib/cleanup.js'),
  images: () => import('./lib/images.js'),
  rules: () => import('./lib/rules.js'),
  save: () => import('./lib/save.js'),
};
const backupIfDue = async () => (await lazy.backup()).backupIfDue();
const runCleanup = async () => (await lazy.cleanup()).runCleanup();

const RECENT_PREFIX = 'recent:';
const RECENT_COUNT = 10;
let recentKey = null; // what the submenu shows now, to skip rebuilding it for nothing
let recentDirty = true;

// Firefox uses "&" as the access-key marker in menu labels.
const menuLabel = s => (s.length > 70 ? s.slice(0, 69) + '…' : s).replace(/&/g, '&&');

async function createMenus() {
  await initI18n();
  return browser.menus.removeAll().then(() => {
    browser.menus.create({ id: 'save-current', title: msg('menuSaveCurrent'), contexts: ['action'] });
    browser.menus.create({ id: 'save-close', title: msg('menuSaveClose'), contexts: ['action'] });
    browser.menus.create({ id: 'save-all-tabs', title: msg('menuSaveAllTabs'), contexts: ['action'] });
    // Right-click on a tab (or on several selected tabs).
    browser.menus.create({ id: 'tab-save', title: msg('menuSaveTabs'), contexts: ['tab'] });
    browser.menus.create({ id: 'tab-save-close', title: msg('menuSaveClose'), contexts: ['tab'] });
    browser.menus.create({ id: 'tab-save-all', title: msg('menuSaveAllTabs'), contexts: ['tab'] });
    browser.menus.create({ id: 'save-link', title: msg('menuSaveLink'), contexts: ['link'] });
    browser.menus.create({ id: 'save-page', title: msg('menuSavePage'), contexts: ['page'] });
    browser.menus.create({ id: 'recent', title: msg('recent'), contexts: ['action'] });
    browser.menus.create({ id: 'view-all', title: msg('viewAll'), contexts: ['action'] });
    browser.menus.create({ id: 'sidebar', title: msg('menuSidebar'), contexts: ['action'] });
    browser.menus.create({ id: 'export', title: msg('export'), contexts: ['action'] });
    browser.menus.create({ id: 'data', title: msg('dataPage'), contexts: ['action'] });
    recentKey = null;
    return refreshRecentMenu();
  });
}

// Rebuild the "Last saved" submenu from the database (only if what it shows has changed).
// Its entries are fixed slots (recent:0 … recent:9), so they can be replaced even after
// Firefox has put this page to sleep and woken it up again.
const RECENT_SLOTS = [...Array(RECENT_COUNT).keys()].map(i => RECENT_PREFIX + i).concat(RECENT_PREFIX + 'empty');
async function refreshRecentMenu() {
  recentDirty = false;
  const items = await recent(RECENT_COUNT);
  const key = items.map(i => `${i.id}\t${displayTitle(i)}`).join('\n');
  if (key === recentKey) return;
  recentKey = key;
  await Promise.all(RECENT_SLOTS.map(id => browser.menus.remove(id).catch(() => {})));
  if (!items.length) {
    browser.menus.create({ id: RECENT_PREFIX + 'empty', parentId: 'recent', title: msg('emptyRecentTitle'), enabled: false, contexts: ['action'] });
    return;
  }
  const icons = await Promise.all(items.map(item => faviconFor(hostOf(item.url))));
  items.forEach((item, i) => {
    const props = { id: RECENT_PREFIX + i, parentId: 'recent', title: menuLabel(displayTitle(item)), contexts: ['action'] };
    if (icons[i]) props.icons = { 16: icons[i] };
    browser.menus.create(props);
  });
}

// ---- "unread" counter on the toolbar button ----
async function updateBadge() {
  const { badge = true } = await browser.storage.local.get('badge').catch(() => ({}));
  if (!badge) return browser.action.setBadgeText({ text: '' });
  const n = await unreadCount();
  await browser.action.setBadgeBackgroundColor({ color: '#185FA5' });
  browser.action.setBadgeTextColor?.({ color: '#ffffff' });
  await browser.action.setBadgeText({ text: n ? (n > 999 ? '999+' : String(n)) : '' });
}

// A short per-tab badge ("✓", "=", "×") that then goes back to the counter.
async function flashBadge(tabId, text, color) {
  if (tabId == null) return;
  await browser.action.setBadgeBackgroundColor({ color, tabId });
  await browser.action.setBadgeText({ text, tabId });
  setTimeout(() => {
    browser.action.setBadgeText({ text: null, tabId });
    browser.action.setBadgeBackgroundColor({ color: null, tabId });
  }, 2000);
}

// ---- address-bar icon: "save" or "already saved" ----
async function updatePageIcon(tab) {
  if (tab?.id == null || !isSavableUrl(tab.url)) return;
  const [saved, icons] = await Promise.all([getByUrl(tab.url).then(Boolean), iconSet()]);
  browser.pageAction.setIcon({ tabId: tab.id, path: saved ? icons.saved : icons.save }).catch(() => {});
  browser.pageAction.setTitle({ tabId: tab.id, title: msg(saved ? 'alreadySaved' : 'pageActionTitle') }).catch(() => {});
}

async function updateAllPageIcons() {
  for (const tab of await browser.tabs.query({})) updatePageIcon(tab);
}

// The icon is only visible on the tab in front, so after a change only those are updated;
// the others are updated when they come to the front.
async function updateActivePageIcons() {
  for (const tab of await browser.tabs.query({ active: true })) updatePageIcon(tab);
}

browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updatePageIcon(tab);
}, { properties: ['url', 'status'] });

browser.tabs.onActivated.addListener(({ tabId }) => {
  browser.tabs.get(tabId).then(updatePageIcon, () => {});
});

// ---- article text from the current tab ----
// Runs inside the web page (injected after vendor/Readability.js).
function extractInPage() {
  try {
    const parsed = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
    if (!parsed) return null;
    const { title, byline, siteName, content, textContent, lang } = parsed;
    return { title, byline, siteName, content, textContent, lang };
  } catch {
    return null;
  }
}

async function saveArticleFromTab(tabId, id, url) {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['vendor/Readability.js'] });
    const [{ result } = {}] = await browser.scripting.executeScript({ target: { tabId }, func: extractInPage });
    const packed = await (await lazy.article()).packArticle(result, url);
    if (packed) {
      await setArticle(id, packed.blob, packed.words, packed.text);
      (await lazy.images()).saveImagesIfEnabled(id).catch(err => console.warn('Offline images not saved:', err));
    }
    else await updateItem(id, { fetchState: 2 });
  } catch (err) {
    console.warn('Article not saved:', err);
    await updateItem(id, { fetchState: 2 }).catch(() => {});
  }
}

// ---- several tabs at once ----
const GREEN = '#0F6E56';
const RED = '#A32D2D';
const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);

// The tabs a click on a tab is about: all the selected ones if the clicked tab is one of them.
async function clickedTabs(tab) {
  const selected = await browser.tabs.query({ windowId: tab.windowId, highlighted: true });
  return selected.some(t => t.id === tab.id) ? selected : [tab];
}

async function saveSeveral(tabs, { close = false, granted = null } = {}) {
  const windowId = tabs[0]?.windowId;
  const front = tabs.find(t => t.active);
  const res = await (await lazy.save()).saveTabs(tabs);
  if (!res.tabs.length) return flashBadge(front?.id, '×', RED);
  // The article is read from the page while it's open. Without site access Firefox only allows
  // it on the tab that was clicked (granted); the rest is left to the background download.
  // When the tabs stay open, only that one is read now, to keep the burst light.
  const canReadAll = await browser.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  const readers = res.tabs.filter(t => !t.discarded && (t.id === granted || (close && canReadAll)));
  const reading = Promise.all(readers.map(async t => {
    const item = await getByUrl(t.url);
    if (item && !item.hasArticle) await withTimeout(saveArticleFromTab(t.id, item.id, t.url), 8000);
  }));
  const n = res.saved.length;
  const text = n ? (res.tabs.length > 1 ? `+${n}` : '✓') : '=';
  if (!close) {
    flashBadge(front?.id, text, GREEN);
    return reading;
  }
  await reading;
  // Closing every tab of the window would close the window: leave a new tab instead.
  const all = await browser.tabs.query({ windowId });
  const closing = new Set(res.tabs.map(t => t.id));
  if (all.every(t => closing.has(t.id))) await browser.tabs.create({ windowId });
  await browser.tabs.remove([...closing]);
  const [now] = await browser.tabs.query({ windowId, active: true });
  flashBadge(now?.id, text, GREEN);
}

// ---- toolbar icon (the user can pick another set in "Data and backups") ----
async function updateToolbarIcon() {
  await browser.action.setIcon({ path: (await iconSet()).toolbar }).catch(() => {});
}

// ---- lifecycle ----
function refreshAll() {
  createMenus();
  updateToolbarIcon();
  updateBadge();
  updateAllPageIcons();
}

initI18n();
browser.runtime.onInstalled.addListener(() => { refreshAll(); runCleanup().catch(console.warn); });
browser.runtime.onStartup.addListener(() => { refreshAll(); backupIfDue().catch(console.warn); runCleanup().catch(console.warn); });

// Changes can come in bursts (a background download, an import): the counter, the icons and
// the submenu are brought up to date once the burst calms down, not once per change.
let backupTimer;
let refreshTimer;
browser.runtime.onMessage.addListener(message => {
  if (message?.type === 'items-changed') {
    recentDirty = true;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(() => backupIfDue().catch(console.warn), 10000);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { updateBadge(); updateActivePageIcons(); }, 500);
    return;
  }
  if (message?.type === 'extract-article') return saveArticleFromTab(message.tabId, message.id, message.url);
});

// The "Last saved" submenu is only rebuilt when it is about to be seen and something changed.
browser.menus.onShown.addListener(async info => {
  if (!info.contexts.includes('action') || !recentDirty) return;
  await refreshRecentMenu();
  browser.menus.refresh();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Language changed in "Data and backups": rebuild the menus in the new language.
  if (changes.language) { createMenus(); updateAllPageIcons(); }
  if (changes.badge) updateBadge();
  if (changes.iconStyle) { updateToolbarIcon(); updateAllPageIcons(); }
});

browser.menus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  // Must run before any await: Firefox only opens the sidebar straight from a user action.
  if (id === 'sidebar') return browser.sidebarAction.toggle();
  if (id === 'save-current') {
    // Right-click on the toolbar button grants activeTab for the current tab.
    const res = await (await lazy.save()).saveTab(tab);
    if (res.status === 'unsavable') return flashBadge(tab?.id, '×', '#A32D2D');
    flashBadge(tab?.id, res.status === 'existed' ? '=' : '✓', '#0F6E56');
    if (!res.item.hasArticle) saveArticleFromTab(tab.id, res.item.id, tab.url);
    return;
  }
  // The menu click grants access to the page of the tab it was made on (tab.id).
  if (id === 'save-close') return saveSeveral([tab], { close: true, granted: tab.id });
  if (id === 'save-all-tabs' || id === 'tab-save-all') return saveSeveral(await browser.tabs.query({ windowId: tab.windowId }), { granted: tab.id });
  if (id === 'tab-save') return saveSeveral(await clickedTabs(tab), { granted: tab.id });
  if (id === 'tab-save-close') return saveSeveral(await clickedTabs(tab), { close: true, granted: tab.id });
  if (id.startsWith(RECENT_PREFIX)) {
    const item = (await recent(RECENT_COUNT))[Number(id.slice(RECENT_PREFIX.length))];
    if (item) browser.tabs.create({ url: item.url });
    return;
  }
  if (id === 'view-all') return openListPage('');
  if (id === 'export') return openListPage('#export');
  if (id === 'data') return openDataPage('');

  const isLink = id === 'save-link';
  const url = isLink ? info.linkUrl : (info.pageUrl || tab?.url);
  if (!isSavableUrl(url)) return flashBadge(tab?.id, '×', '#A32D2D');
  const title = isLink ? (info.linkText || '').trim() || url : (tab?.title || url);
  const { applyRules, loadRules } = await lazy.rules();
  const rec = applyRules({ title, url, time_added: nowSeconds(), tags: [], status: 'unread' }, await loadRules());
  const { item, existed } = await addItem(rec);
  flashBadge(tab?.id, existed ? '=' : '✓', '#0F6E56');
  // Right-click on the page grants activeTab, so we can keep the article too.
  if (!isLink && tab?.id != null && !item.hasArticle) saveArticleFromTab(tab.id, item.id, url);
});
