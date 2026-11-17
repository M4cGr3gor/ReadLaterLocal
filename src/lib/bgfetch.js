// Background download of text/title/thumbnail for items that don't have them yet.
// Without the "alarms" permission Firefox puts the background script to sleep, so this runs
// inside the pages that are open ("View all", "Data and backups"); a Web Lock makes sure only
// one open page does the work at a time.
import * as db from './db.js';
import { decompressJson } from './article.js';
import { fetchAll, hasSitePermission } from './fetcher.js';

const LOCK = 'read-later-local-bgfetch';

export async function bgFetchEnabled() {
  const { bgFetch = false } = await browser.storage.local.get('bgFetch').catch(() => ({}));
  return bgFetch;
}

let controller = null;

export function stopBackgroundFetch() {
  controller?.abort();
}

/**
 * Downloads, slowly and one at a time, every pending item. Resolves when done, stopped,
 * or immediately if it's off, lacks permission, or another page is already doing it.
 */
export async function runBackgroundFetch({ onProgress } = {}) {
  if (!(await bgFetchEnabled()) || !(await hasSitePermission())) return null;
  const work = async () => {
    const pending = await db.itemsToFetch(false);
    const known = new Set(pending.map(i => i.id));
    const items = [...pending, ...(await db.itemsWithBrokenText()).filter(i => !known.has(i.id))];
    if (!items.length) return null;
    controller = new AbortController();
    const stop = (changes, area) => { if (area === 'local' && changes.bgFetch?.newValue === false) controller.abort(); };
    browser.storage.onChanged.addListener(stop);
    try {
      return await fetchAll(items, { signal: controller.signal, onProgress, concurrency: 1, pauseMs: 1500 });
    } finally {
      browser.storage.onChanged.removeListener(stop);
      controller = null;
    }
  };
  if (!navigator.locks) return work();
  return navigator.locks.request(LOCK, { ifAvailable: true }, lock => (lock ? work() : null));
}

// Texts saved by v1.6–1.8 take several times the space they need: rewrite them once.
async function compactTextsOnce() {
  const { textsCompact } = await browser.storage.local.get('textsCompact').catch(() => ({}));
  if (textsCompact) return;
  await db.compactTexts();
  await browser.storage.local.set({ textsCompact: 1 });
}

// Articles saved before v1.6 (or restored from a backup) have no searchable text yet.
export async function backfillTexts() {
  await compactTextsOnce().catch(err => console.warn('Texts not compacted:', err));
  const ids = await db.idsMissingText();
  for (const id of ids) {
    const blob = await db.getArticle(id);
    if (!blob) continue;
    try {
      const art = await decompressJson(blob);
      const text = new DOMParser().parseFromString(art.html || '', 'text/html').body.textContent;
      await db.setText(id, `${art.title || ''} ${text}`);
    } catch { /* unreadable article: skip */ }
  }
  return ids.length;
}

// Articles saved before v1.4 have no word count yet: read it from the stored article once.
export async function backfillWordCounts() {
  const missing = (await db.allItems()).filter(i => i.hasArticle && !i.words);
  for (const item of missing) {
    const blob = await db.getArticle(item.id);
    if (!blob) continue;
    try {
      const art = await decompressJson(blob);
      const words = art.words || (art.html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
      if (words) await db.updateItem(item.id, { words });
    } catch { /* unreadable article: skip */ }
  }
  return missing.length;
}
