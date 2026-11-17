// Saving a tab (used by the address-bar button's popup and by the right-click menu).
import * as db from './db.js';
import { hostOf, isSavableUrl, nowSeconds } from './util.js';
import { makeThumb, faviconToDataUrl } from './thumbs.js';
import { applyRules, loadRules } from './rules.js';

async function captureThumb(tab) {
  try {
    const shot = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
    return await makeThumb(shot);
  } catch {
    return null; // Privileged pages (addons.mozilla.org, reader view…) can't be captured.
  }
}

/**
 * @returns {Promise<{status:'unsavable'} | {status:'existed'|'saved', item:object}>}
 */
export async function saveTab(tab) {
  if (!tab || !isSavableUrl(tab.url)) return { status: 'unsavable' };
  const existing = await db.getByUrl(tab.url);
  if (existing) return { status: 'existed', item: existing };
  const hasIcon = !!(await db.getFavicon(hostOf(tab.url)));
  const [thumb, favicon] = await Promise.all([captureThumb(tab), hasIcon ? null : faviconToDataUrl(tab.favIconUrl)]);
  const rec = applyRules({ title: tab.title || tab.url, url: tab.url, time_added: nowSeconds(), tags: [], status: 'unread', favicon }, await loadRules());
  const { item, existed } = await db.addItem(rec, thumb);
  return { status: existed ? 'existed' : 'saved', item };
}

/**
 * Saves several tabs at once. The one in front gets a screenshot thumbnail (only it can be
 * captured); the others are completed later by the background download or the reader.
 * @returns {Promise<{saved:object[], existed:object[], tabs:object[]}>} tabs: the savable ones
 */
export async function saveTabs(tabs) {
  const savable = tabs.filter(tab => isSavableUrl(tab.url));
  const front = savable.find(tab => tab.active);
  const saved = [];
  const existed = [];
  if (front) {
    const res = await saveTab(front);
    (res.status === 'saved' ? saved : existed).push(res.item);
  }
  const rules = await loadRules();
  const time = nowSeconds();
  const others = savable.filter(tab => tab !== front);
  // Site icons only for sites that don't have one yet, fetched side by side.
  const icons = await Promise.all(others.map(async tab =>
    tab.favIconUrl && !(await db.getFavicon(hostOf(tab.url))) ? faviconToDataUrl(tab.favIconUrl) : null));
  const recs = others.map((tab, i) => applyRules({ title: tab.title || tab.url, url: tab.url, time_added: time, tags: [], status: 'unread', favicon: icons[i] }, rules));
  const res = await db.addItems(recs);
  return { saved: [...saved, ...res.added], existed: [...existed, ...res.existed], tabs: savable };
}

export async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}
