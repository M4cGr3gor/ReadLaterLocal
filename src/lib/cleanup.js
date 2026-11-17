// Automatic cleanup: rules such as "items in collection X older than a month" and the
// per-item "delete in…" date move items to the trash (only title + url are kept there);
// the trash itself is emptied of entries older than 30 days.
// It runs when Firefox starts and when "View all" or "Data and backups" open
// (there is no "alarms" permission, so nothing wakes the extension on a timer).
import * as db from './db.js';
import { hostOf, normalize, normalizeTags, nowSeconds } from './util.js';

export const TRASH_DAYS = 30;
const DAY = 86400;
export const UNIT_SECONDS = { day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };

/**
 * @typedef {{id:string, active:boolean, scope:'all'|'collection'|'tag'|'site', value:string,
 *            status:'any'|'unread'|'archive', amount:number, unit:'day'|'week'|'month'|'year'}} CleanupRule
 */

export function newCleanupRule() {
  return { id: 'k' + Date.now().toString(36), active: false, scope: 'collection', value: '', status: 'any', amount: 1, unit: 'month' };
}

/** A rule is usable when it says what it applies to and how old items must be. */
export function isComplete(rule) {
  if (!rule || !(Number(rule.amount) > 0) || !UNIT_SECONDS[rule.unit]) return false;
  return rule.scope === 'all' || !!String(rule.value || '').trim();
}

export function cleanupMatches(rule, item, now = nowSeconds()) {
  if (!isComplete(rule)) return false;
  if (rule.status === 'unread' && item.status === 'archive') return false;
  if (rule.status === 'archive' && item.status !== 'archive') return false;
  if (now - item.time_added < Number(rule.amount) * UNIT_SECONDS[rule.unit]) return false;
  const value = String(rule.value || '').trim();
  if (rule.scope === 'collection') return item.collection === value;
  if (rule.scope === 'tag') return (item.tags || []).includes(normalizeTags([value])[0]);
  if (rule.scope === 'site') {
    const host = hostOf(item.url);
    const site = normalize(value).replace(/^www\./, '');
    return host === site || host.endsWith('.' + site);
  }
  return rule.scope === 'all';
}

/** Ids of the items that are due: their own date passed, or an active rule matches them. */
export function dueIds(items, rules, now = nowSeconds()) {
  const active = rules.filter(r => r.active && isComplete(r));
  return items
    .filter(i => (i.expires && i.expires <= now) || active.some(r => cleanupMatches(r, i, now)))
    .map(i => i.id);
}

export async function loadCleanupRules() {
  const { cleanup = [] } = await browser.storage.local.get('cleanup').catch(() => ({}));
  return Array.isArray(cleanup) ? cleanup : [];
}

export async function saveCleanupRules(cleanup) {
  await browser.storage.local.set({ cleanup });
}

let running = null;
/** Moves what's due to the trash and empties old trash. Returns { trashed, purged }. */
export function runCleanup() {
  running ??= (async () => {
    try {
      const ids = dueIds(await db.allItems(), await loadCleanupRules());
      const trashed = ids.length ? await db.moveToTrash(ids) : 0;
      const purged = await db.purgeTrash(Date.now() - TRASH_DAYS * DAY * 1000);
      return { trashed, purged };
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Days left before a trash entry is deleted for good. */
export function daysLeft(deletedAt, now = Date.now()) {
  return Math.max(0, Math.ceil((deletedAt + TRASH_DAYS * DAY * 1000 - now) / (DAY * 1000)));
}

/** Choices for "delete in…": seconds from now. */
export const EXPIRE_CHOICES = [
  ['expire1d', DAY], ['expire1w', 7 * DAY], ['expire1m', 30 * DAY],
  ['expire3m', 90 * DAY], ['expire6m', 180 * DAY], ['expire1y', 365 * DAY],
];
