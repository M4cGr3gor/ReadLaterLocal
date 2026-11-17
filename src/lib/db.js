// IndexedDB storage, kept compact on purpose:
//  - items:    one small record per saved page (no images, no article text)
//  - thumbs:   id -> small WebP Blob, loaded only when a card is on screen
//  - articles: id -> gzip Blob with the readable article (text only)
//  - favicons: host -> data URL, one per site instead of one per item
//  - trash:    what was deleted, reduced to title + url, kept for 30 days
//  - texts:    id -> every different word of the article once, normalised, for full-text search
//  - images:   the article's pictures saved for offline reading (only when asked for)
//  - highlights: highlights and notes made in the reader
//  - positions: id -> how far the article has been read (0–1), to open it where it was left
import { hostOf, matchesQuery, normalize, normalizeTags, nowSeconds, parseQuery } from './util.js';
import { detectKind, isShortRead } from './classify.js';
import { cleanUrl, urlKey } from './urls.js';

const DB_NAME = 'read-later-local';
const DB_VERSION = 6;
let dbPromise = null;

// fetchState: 0 pending · 1 article saved · 2 tried, no article · 3 nothing to fetch (video/image)
// expires: 0, or the time (seconds) after which cleanup moves the item to the trash
// images: 1 when the article's pictures are stored offline (imageBytes: their size) · hl: highlights count
// noImages: 1 when the user removed this article's pictures (the general switch then leaves it alone)
const DEFAULTS = { tags: [], favorite: 0, hasArticle: 0, fetchState: 0, words: 0, note: '', collection: '', expires: 0, images: 0, imageBytes: 0, hl: 0, noImages: 0 };
// Stores holding data that belongs to one item (keyed by its id, or by an itemId index).
const BY_ID = ['thumbs', 'articles', 'texts', 'positions'];
const BY_ITEM = ['images', 'highlights'];

// Brings an item from any older version up to the current shape.
function migrateItem(value, oldVersion, favicons) {
  const item = { ...value };
  if (oldVersion < 2) {
    const host = hostOf(item.url);
    if (item.favicon && host) favicons.put({ host, icon: item.favicon });
    delete item.favicon;
    item.tags = normalizeTags(item.tags);
    item.favorite = item.favorite ? 1 : 0;
    item.hasArticle = 0;
    item.fetchState = 0;
  }
  delete item.soon; // the "Read soon" list was removed in v4
  item.ukey = urlKey(item.url); // v6: spots the same page under another address
  for (const [k, v] of Object.entries(DEFAULTS)) if (item[k] === undefined) item[k] = Array.isArray(v) ? [] : v;
  item.kind = detectKind(item);
  return item;
}

function upgrade(d, oldVersion, tx) {
  if (oldVersion < 1) {
    const items = d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
    items.createIndex('url', 'url', { unique: true });
    items.createIndex('time_added', 'time_added');
    items.createIndex('status_time', ['status', 'time_added']);
    d.createObjectStore('thumbs', { keyPath: 'id' });
  }
  if (oldVersion < 2) {
    tx.objectStore('items').createIndex('fav_time', ['favorite', 'time_added']);
    d.createObjectStore('articles', { keyPath: 'id' });
    d.createObjectStore('favicons', { keyPath: 'host' });
  }
  if (oldVersion < 4) {
    d.createObjectStore('trash', { keyPath: 'id', autoIncrement: true }).createIndex('deletedAt', 'deletedAt');
  }
  if (oldVersion < 5) {
    d.createObjectStore('texts', { keyPath: 'id' });
    d.createObjectStore('images', { keyPath: 'key', autoIncrement: true }).createIndex('itemId', 'itemId');
    d.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true }).createIndex('itemId', 'itemId');
  }
  if (oldVersion < 6) {
    tx.objectStore('items').createIndex('ukey', 'ukey');
    d.createObjectStore('positions', { keyPath: 'id' });
  }
  if (oldVersion >= 1 && oldVersion < DB_VERSION) {
    const favicons = tx.objectStore('favicons');
    tx.objectStore('items').openCursor().onsuccess = e => {
      const cur = e.target.result;
      if (!cur) return;
      cur.update(migrateItem(cur.value, oldVersion, favicons));
      cur.continue();
    };
  }
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => upgrade(req.result, e.oldVersion, req.transaction);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

const done = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const finished = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
});

// Lets the background script (menus, badge, address-bar icon) and the other open pages
// ("View all", the reader) refresh. ids: the items that changed, or null when it's many/unknown.
function notifyChanged(ids = null) {
  globalThis.browser?.runtime?.sendMessage({ type: 'items-changed', ids }).catch(() => {});
}

async function tx(stores, mode = 'readonly') {
  return (await openDb()).transaction(stores, mode);
}

// Derived fields are recomputed on every write so they never go stale.
function finalize(item) {
  item.tags = normalizeTags(item.tags);
  item.kind = detectKind(item);
  item.ukey = urlKey(item.url);
  item.expires = Number(item.expires) > 0 ? Math.floor(Number(item.expires)) : 0;
  return item;
}

function makeItem(rec) {
  return finalize({
    title: rec.title || rec.url,
    url: cleanUrl(rec.url),
    time_added: rec.time_added,
    tags: rec.tags,
    status: rec.status === 'archive' ? 'archive' : 'unread',
    favorite: rec.favorite ? 1 : 0,
    hasArticle: 0,
    fetchState: 0,
    words: 0,
    note: typeof rec.note === 'string' ? rec.note.slice(0, 5000) : '',
    collection: typeof rec.collection === 'string' ? rec.collection : '',
    expires: rec.expires,
    images: 0,
    imageBytes: 0,
    hl: 0,
    noImages: 0,
  });
}

function putFaviconIfMissing(store, url, icon) {
  const host = hostOf(url);
  if (!icon || !host) return;
  store.get(host).onsuccess = e => { if (!e.target.result) store.put({ host, icon }); };
}

// The stored item for an address: the same address, or the same page under another one
// (tracking parameters, "www.", an anchor…). Used inside any transaction that has "items".
async function findByUrl(store, url) {
  return (await done(store.index('url').get(url)))
    ?? (await done(store.index('url').get(cleanUrl(url))))
    ?? (await done(store.index('ukey').get(urlKey(url))))
    ?? null;
}

export async function getByUrl(url) {
  const t = await tx('items');
  return findByUrl(t.objectStore('items'), url);
}

export async function getItem(id) {
  const t = await tx('items');
  return (await done(t.objectStore('items').get(id))) ?? null;
}

// Returns { item, existed }. An existing url is never overwritten.
export async function addItem(rec, thumbBlob = null) {
  const t = await tx(['items', 'thumbs', 'favicons'], 'readwrite');
  const items = t.objectStore('items');
  const existing = await findByUrl(items, rec.url);
  if (existing) { await finished(t); return { item: existing, existed: true }; }
  const item = makeItem(rec);
  item.id = await done(items.add(item));
  if (thumbBlob) t.objectStore('thumbs').put({ id: item.id, blob: thumbBlob });
  putFaviconIfMissing(t.objectStore('favicons'), rec.url, rec.favicon);
  await finished(t);
  notifyChanged([item.id]);
  return { item, existed: false };
}

/**
 * Saves several pages at once (e.g. every tab of a window): one transaction and one change
 * notice for all of them. Returns the new items and the ones that were already saved.
 */
export async function addItems(recs) {
  const t = await tx(['items', 'favicons'], 'readwrite');
  const items = t.objectStore('items');
  const added = [];
  const existed = [];
  const seen = new Set();
  for (const rec of recs) {
    const key = urlKey(rec.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = await findByUrl(items, rec.url);
    if (existing) { existed.push(existing); continue; }
    const item = makeItem(rec);
    item.id = await done(items.add(item));
    putFaviconIfMissing(t.objectStore('favicons'), rec.url, rec.favicon);
    added.push(item);
  }
  await finished(t);
  if (added.length) notifyChanged(added.map(i => i.id));
  return { added, existed };
}

export async function updateItem(id, patch) {
  return (await updateItems([id], patch))[0] ?? null;
}

/**
 * Applies the same change to many items in one transaction.
 * @param {number[]} ids
 * @param {object|((item:object)=>object)} patch  fields to set, or a function returning them
 */
export async function updateItems(ids, patch) {
  const t = await tx(['items', 'images'], 'readwrite');
  const store = t.objectStore('items');
  const out = [];
  for (const id of ids) {
    const item = await done(store.get(id));
    if (!item) continue;
    const changes = typeof patch === 'function' ? patch(item) : patch;
    const updated = finalize({ ...item, ...changes, id });
    if (updated.status === 'archive' && item.status !== 'archive' && item.images) {
      // Offline pictures are only kept while an item is unread.
      await deleteByItem(t.objectStore('images'), id);
      updated.images = 0;
      updated.imageBytes = 0;
    }
    store.put(updated);
    out.push(updated);
  }
  await finished(t);
  if (out.length) notifyChanged(out.map(i => i.id));
  return out;
}

// Everything stored for one item outside the items store, removed from the transaction.
async function takeRelated(t, id) {
  const rel = {};
  for (const name of BY_ID) {
    rel[name] = (await done(t.objectStore(name).get(id))) ?? null;
    t.objectStore(name).delete(id);
  }
  for (const name of BY_ITEM) rel[name] = await deleteByItem(t.objectStore(name), id);
  return { thumb: rel.thumbs?.blob ?? null, article: rel.articles?.blob ?? null, text: rel.texts?.text ?? null, images: rel.images, highlights: rel.highlights };
}

function putRelated(t, item, { thumb, article, text, images = [], highlights = [] }) {
  if (thumb) t.objectStore('thumbs').put({ id: item.id, blob: thumb });
  if (article) t.objectStore('articles').put({ id: item.id, blob: article });
  if (text) t.objectStore('texts').put({ id: item.id, text });
  for (const row of images) t.objectStore('images').put(row);
  for (const row of highlights) t.objectStore('highlights').put(row);
}

async function deleteByItem(store, itemId) {
  const rows = await done(store.index('itemId').getAll(itemId));
  for (const row of rows) store.delete(row[store.keyPath]);
  return rows;
}

const ALL_ITEM_STORES = ['items', ...BY_ID, ...BY_ITEM];

// Returns what was removed so the caller can offer "undo".
export async function deleteItem(id) {
  return (await deleteItems([id]))[0] ?? { item: null, thumb: null, article: null };
}

export async function deleteItems(ids) {
  const t = await tx(ALL_ITEM_STORES, 'readwrite');
  const removed = [];
  for (const id of ids) {
    const item = await done(t.objectStore('items').get(id));
    if (!item) continue;
    t.objectStore('items').delete(id);
    removed.push({ item, ...(await takeRelated(t, id)) });
  }
  await finished(t);
  if (removed.length) notifyChanged(removed.map(r => r.item.id));
  return removed;
}

export async function restoreItem(item, thumbBlob = null, articleBlob = null) {
  return restoreItems([{ item, thumb: thumbBlob, article: articleBlob }]);
}

export async function restoreItems(removed) {
  const t = await tx(ALL_ITEM_STORES, 'readwrite');
  for (const rel of removed) {
    t.objectStore('items').put(rel.item);
    putRelated(t, rel.item, rel);
  }
  await finished(t);
  notifyChanged(removed.map(r => r.item.id));
}

export async function getThumb(id) {
  const t = await tx('thumbs');
  return (await done(t.objectStore('thumbs').get(id)))?.blob ?? null;
}

export async function setThumb(id, blob) {
  const t = await tx('thumbs', 'readwrite');
  t.objectStore('thumbs').put({ id, blob });
  await finished(t);
}

export async function getFavicon(host) {
  const t = await tx('favicons');
  return (await done(t.objectStore('favicons').get(host)))?.icon ?? null;
}

export async function setFavicon(host, icon) {
  const t = await tx('favicons', 'readwrite');
  t.objectStore('favicons').put({ host, icon });
  await finished(t);
}

export async function getArticle(id) {
  const t = await tx('articles');
  return (await done(t.objectStore('articles').get(id)))?.blob ?? null;
}

// Punctuation around a word ("hola," "(texto)") is not part of it. The "�" of a badly
// decoded page is kept, so broken articles can still be found and repaired.
const trimWord = w => w.replace(/^[^\p{L}\p{N}�]+|[^\p{L}\p{N}�]+$/gu, '');

/**
 * Turns article text into what full-text search compares against: each different word once,
 * without accents or capitals. Search only asks "is every word there?", so the order and the
 * repeats aren't needed, and the text takes a fraction of the space.
 */
export function searchText(text) {
  const words = new Set();
  for (const raw of normalize(text).split(/\s+/)) {
    const w = trimWord(raw);
    if (w) words.add(w);
  }
  return [...words].join(' ');
}

export async function setArticle(id, blob, words = 0, text = '') {
  const t = await tx(['items', 'articles', 'texts'], 'readwrite');
  const items = t.objectStore('items');
  const item = await done(items.get(id));
  if (item) {
    t.objectStore('articles').put({ id, blob });
    if (text) t.objectStore('texts').put({ id, text: searchText(text) });
    items.put(finalize({ ...item, hasArticle: 1, fetchState: 1, words: words || item.words || 0 }));
  }
  await finished(t);
  if (item) notifyChanged([id]);
  return !!item;
}

// Frees space: drops the saved text of archived items (the links stay).
export async function deleteArchivedArticles() {
  const t = await tx(['items', 'articles', 'texts', 'images'], 'readwrite');
  const items = t.objectStore('items');
  const range = IDBKeyRange.bound(['archive', -Infinity], ['archive', Infinity]);
  const archived = await done(items.index('status_time').getAll(range));
  let n = 0;
  for (const item of archived) {
    if (!item.hasArticle) continue;
    t.objectStore('articles').delete(item.id);
    t.objectStore('texts').delete(item.id);
    await deleteByItem(t.objectStore('images'), item.id);
    items.put(finalize({ ...item, hasArticle: 0, images: 0, imageBytes: 0 }));
    n++;
  }
  await finished(t);
  return n;
}

export async function recent(limit) {
  return (await page({ status: 'all', query: '', after: null, limit })).items;
}

/**
 * Filters for listing. status: 'unread'|'archive'|'favorite'|'all'; kind: '' or a kind
 * ('other' also covers 'unknown'); collection: '' any, '-' none, or an id; short: only <5 min reads.
 */
function predicate({ status = 'all', query = '', kind = '', collection = '', short = false }, inText = null) {
  const q = parseQuery(query);
  const noText = { ...q, text: '' };
  return item => {
    if (kind && item.kind !== kind && !(kind === 'other' && item.kind === 'unknown')) return false;
    if (collection === '-' && item.collection) return false;
    if (collection && collection !== '-' && item.collection !== collection) return false;
    if (short && !isShortRead(item.words)) return false;
    if (matchesQuery(item, q)) return true;
    // Not in title/url/note: maybe in the article text (then flagged for the card).
    if (inText?.has(item.id) && matchesQuery(item, noText)) { item._inText = true; return true; }
    return false;
  };
}

// Ids whose article text contains every word of the query. Cached for the batches of one search.
let textCache = { text: null, ids: null };
async function textMatches(query, fresh) {
  const { text } = parseQuery(query);
  if (!text) return null;
  if (!fresh && textCache.text === text) return textCache.ids;
  const words = text.split(' ').map(w => trimWord(w) || w).filter(Boolean);
  const ids = new Set();
  const t = await tx('texts');
  await new Promise((resolve, reject) => {
    const req = t.objectStore('texts').openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      if (words.every(w => cur.value.text.includes(w))) ids.add(cur.value.id);
      cur.continue();
    };
  });
  textCache = { text, ids };
  return ids;
}

function indexFor(store, status) {
  if (status === 'favorite') return { index: store.index('fav_time'), lower: [1, -Infinity], upper: [1, Infinity] };
  if (status === 'unread' || status === 'archive') {
    return { index: store.index('status_time'), lower: [status, -Infinity], upper: [status, Infinity] };
  }
  return { index: store.index('time_added'), lower: -Infinity, upper: Infinity };
}

/**
 * One batch of items in time order (newest first by default).
 * @param {{status?:string, query?:string, kind?:string, collection?:string, short?:boolean,
 *          order?:'newest'|'oldest', after?:{key:any,id:number}|null, limit?:number}} opts
 * @returns {Promise<{items:object[], next:{key:any,id:number}|null}>} next is null when there is nothing more.
 */
export async function page(opts) {
  const { status = 'all', after = null, limit = 30, order = 'newest' } = opts;
  const inText = await textMatches(opts.query, !after); // before opening the items transaction
  const t = await tx('items');
  const { index, lower, upper } = indexFor(t.objectStore('items'), status);
  const newest = order !== 'oldest';
  const range = after
    ? (newest ? IDBKeyRange.bound(lower, after.key) : IDBKeyRange.bound(after.key, upper))
    : IDBKeyRange.bound(lower, upper);
  const accept = predicate(opts, inText);
  const items = [];
  let next = null;

  await new Promise((resolve, reject) => {
    const req = index.openCursor(range, newest ? 'prev' : 'next');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      // Entries sharing the boundary key were already returned up to after.id
      // (within one index key the cursor walks primary keys in the same direction).
      if (after && indexedDB.cmp(cur.key, after.key) === 0 && (newest ? cur.primaryKey >= after.id : cur.primaryKey <= after.id)) {
        return cur.continue();
      }
      const value = cur.value;
      if (accept(value)) {
        if (items.length === limit) { next = { key: items.at(-1)._key, id: items.at(-1).id }; return resolve(); }
        items.push({ ...value, _key: cur.key });
      }
      cur.continue();
    };
  });
  for (const i of items) delete i._key;
  return { items, next };
}

// All ids matching the filters (cheap: ids only), e.g. for "Surprise me" or "select all".
export async function matchingIds(opts) {
  const accept = predicate(opts, await textMatches(opts.query, true));
  const t = await tx('items');
  const { index, lower, upper } = indexFor(t.objectStore('items'), opts.status || 'all');
  const all = await done(index.getAll(IDBKeyRange.bound(lower, upper)));
  return all.filter(accept).map(i => i.id);
}

export async function randomItem(opts) {
  const ids = await matchingIds(opts);
  return ids.length ? getItem(ids[Math.floor(Math.random() * ids.length)]) : null;
}

// Counts from the indexes alone: no item is read, so it stays cheap with thousands of them.
export async function counts() {
  const t = await tx(['items', 'trash']);
  const items = t.objectStore('items');
  const byStatus = s => done(items.index('status_time').count(IDBKeyRange.bound([s, -Infinity], [s, Infinity])));
  const [unread, archive, favorite, all, trash] = await Promise.all([
    byStatus('unread'),
    byStatus('archive'),
    done(items.index('fav_time').count(IDBKeyRange.bound([1, -Infinity], [1, Infinity]))),
    done(items.count()),
    done(t.objectStore('trash').count()),
  ]);
  return { unread, archive, favorite, all, trash };
}

export async function unreadCount() {
  const t = await tx('items');
  return done(t.objectStore('items').index('status_time').count(IDBKeyRange.bound(['unread', -Infinity], ['unread', Infinity])));
}

/**
 * Everything the tags/sites bar and the tag suggestions need, in one pass over the items:
 * tags and sites with their counts (most used first), and which tags each site uses.
 */
export async function facetStats() {
  const tags = new Map();
  const sites = new Map();
  const siteTags = new Map();
  const t = await tx('items');
  await new Promise((resolve, reject) => {
    const req = t.objectStore('items').openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const { url, tags: itemTags } = cur.value;
      const host = hostOf(url);
      if (host) sites.set(host, (sites.get(host) || 0) + 1);
      if (itemTags?.length) {
        if (!siteTags.has(host)) siteTags.set(host, new Map());
        const m = siteTags.get(host);
        for (const tag of itemTags) { tags.set(tag, (tags.get(tag) || 0) + 1); m.set(tag, (m.get(tag) || 0) + 1); }
      }
      cur.continue();
    };
  });
  const sorted = (map, name) => [...map].map(([key, count]) => ({ [name]: key, count }))
    .sort((a, b) => b.count - a.count || a[name].localeCompare(b[name]));
  const tagList = sorted(tags, 'tag');
  return { tags: tagList, sites: sorted(sites, 'site'), siteTags, allTags: tagList.map(x => x.tag) };
}

export async function allTags() {
  return (await facetStats()).tags;
}

// Sites with how many items each, most saved first.
export async function siteCounts() {
  return (await facetStats()).sites;
}

// Input for tag suggestions: which tags are used on each site, and every tag in use.
export async function tagStats() {
  const { siteTags, allTags: all } = await facetStats();
  return { siteTags, allTags: all };
}

// Adds records whose url is not stored yet (nor repeated earlier in the same batch).
export async function importRecords(records) {
  const t = await tx('items', 'readwrite');
  const store = t.objectStore('items');
  const seen = new Set();
  let added = 0;
  let duplicates = 0;
  for (const r of records) {
    const key = urlKey(r.url);
    if (seen.has(key) || (await findByUrl(store, r.url))) { duplicates++; continue; }
    seen.add(key);
    store.add(makeItem(r));
    added++;
  }
  await finished(t);
  if (added) notifyChanged();
  return { added, duplicates };
}

export async function allItems() {
  const t = await tx('items');
  const list = await done(t.objectStore('items').index('time_added').getAll());
  return list.reverse();
}

// Items whose article hasn't been downloaded yet (oldest first, so progress is stable).
export async function itemsToFetch(includeFailed) {
  return (await allItems())
    .filter(i => !i.hasArticle && (i.fetchState === 0 || (includeFailed && i.fetchState === 2)))
    .reverse();
}

// Collections are kept on items as an id; removing one leaves its items without collection.
export async function clearCollection(collectionId) {
  const ids = (await allItems()).filter(i => i.collection === collectionId).map(i => i.id);
  return updateItems(ids, { collection: '' });
}

export async function storageStats() {
  const t = await tx(['items', 'thumbs', 'articles', 'favicons', 'texts', 'images']);
  const sizes = async name => {
    let count = 0;
    let bytes = 0;
    await new Promise((resolve, reject) => {
      const req = t.objectStore(name).openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        count++;
        bytes += cur.value.blob?.size ?? cur.value.icon?.length ?? cur.value.text?.length ?? 0;
        cur.continue();
      };
    });
    return { count, bytes };
  };
  const [items, thumbs, articles, favicons, texts, images] = await Promise.all([
    done(t.objectStore('items').count()), sizes('thumbs'), sizes('articles'), sizes('favicons'), sizes('texts'), sizes('images'),
  ]);
  return {
    items,
    texts: texts.count, textBytes: texts.bytes,
    images: images.count, imageBytes: images.bytes,
    thumbs: thumbs.count, thumbBytes: thumbs.bytes,
    articles: articles.count, articleBytes: articles.bytes,
    favicons: favicons.count, faviconBytes: favicons.bytes,
  };
}

// ---- full backup ----
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}
const dataUrlToBlob = async url => (await fetch(url)).blob();

/** @param {{images?:boolean}} opts  images: also include the offline pictures (much bigger). */
export async function exportFull({ images = false } = {}) {
  const t = await tx(['items', 'thumbs', 'articles', 'favicons', 'highlights', 'images']);
  const [items, thumbs, articles, favicons, highlights] = await Promise.all([
    done(t.objectStore('items').index('time_added').getAll()),
    done(t.objectStore('thumbs').getAll()),
    done(t.objectStore('articles').getAll()),
    done(t.objectStore('favicons').getAll()),
    done(t.objectStore('highlights').getAll()),
  ]);
  const pictures = images ? await done(t.objectStore('images').getAll()) : [];
  const group = rows => {
    const m = new Map();
    for (const r of rows) m.set(r.itemId, [...(m.get(r.itemId) || []), r]);
    return m;
  };
  const thumbById = new Map(thumbs.map(r => [r.id, r.blob]));
  const articleById = new Map(articles.map(r => [r.id, r.blob]));
  const hlById = group(highlights);
  const imgById = group(pictures);
  const out = [];
  for (const { id, images: hasImages, imageBytes, ...item } of items.reverse()) {
    const row = { ...item };
    if (thumbById.has(id)) row.thumb = await blobToDataUrl(thumbById.get(id));
    if (articleById.has(id)) row.article = await blobToDataUrl(articleById.get(id));
    if (hlById.has(id)) row.highlights = hlById.get(id).map(({ id: _i, itemId: _x, ...h }) => h);
    if (imgById.has(id)) {
      row.images = [];
      for (const img of imgById.get(id)) row.images.push({ url: img.url, data: await blobToDataUrl(img.blob) });
    }
    out.push(row);
  }
  return {
    format: 'read-later-local',
    version: 5,
    exported: new Date().toISOString(),
    items: out,
    favicons: Object.fromEntries(favicons.map(f => [f.host, f.icon])),
  };
}

// Merges a backup: never deletes or overwrites; fills in what's missing locally.
export async function importFull(data) {
  const prepared = [];
  for (const row of data.items) {
    if (!row?.url) continue;
    prepared.push({
      row,
      thumb: row.thumb ? await dataUrlToBlob(row.thumb) : null,
      article: row.article ? await dataUrlToBlob(row.article) : null,
      pictures: Array.isArray(row.images) ? await Promise.all(row.images.filter(i => i?.url && i?.data).map(async i => ({ url: i.url, blob: await dataUrlToBlob(i.data) }))) : [],
      highlights: Array.isArray(row.highlights) ? row.highlights.filter(h => Number.isInteger(h?.start) && Number.isInteger(h?.end) && typeof h.text === 'string') : [],
    });
  }
  const t = await tx(['items', 'thumbs', 'articles', 'favicons', 'images', 'highlights'], 'readwrite');
  const items = t.objectStore('items');
  const thumbs = t.objectStore('thumbs');
  const articles = t.objectStore('articles');
  let added = 0;
  let merged = 0;
  const addExtras = (id, { pictures, highlights }, into) => {
    for (const p of pictures) t.objectStore('images').add({ itemId: id, url: p.url, blob: p.blob });
    for (const h of highlights) t.objectStore('highlights').add({ ...h, itemId: id, note: String(h.note || '').slice(0, 5000) });
    if (pictures.length && into.status !== 'archive') { into.images = 1; into.imageBytes = pictures.reduce((n, p) => n + p.blob.size, 0); }
    into.hl = highlights.length;
  };
  for (const prep of prepared) {
    const { row, thumb, article } = prep;
    const existing = await findByUrl(items, row.url);
    if (!existing) {
      const item = makeItem(row);
      if (article) { item.hasArticle = 1; item.fetchState = 1; item.words = row.words || 0; }
      const id = await done(items.add(finalize(item)));
      if (thumb) thumbs.put({ id, blob: thumb });
      if (article) articles.put({ id, blob: article });
      if (prep.pictures.length || prep.highlights.length) {
        addExtras(id, { pictures: item.status === 'archive' ? [] : prep.pictures, highlights: prep.highlights }, item);
        items.put({ ...item, id });
      }
      added++;
      continue;
    }
    const update = { ...existing, tags: [...(existing.tags || []), ...normalizeTags(row.tags)] };
    if (row.favorite) update.favorite = 1;
    if (row.note && !existing.note) update.note = row.note;
    if (row.collection && !existing.collection) update.collection = row.collection;
    if (article && !existing.hasArticle) {
      articles.put({ id: existing.id, blob: article });
      Object.assign(update, { hasArticle: 1, fetchState: 1, words: row.words || existing.words || 0 });
    }
    if (thumb && !(await done(thumbs.getKey(existing.id)))) thumbs.put({ id: existing.id, blob: thumb });
    // Highlights and pictures only come in when the local copy has none (offsets belong to one text).
    const extras = { pictures: existing.images || existing.status === 'archive' ? [] : prep.pictures, highlights: existing.hl ? [] : prep.highlights };
    if (extras.pictures.length || extras.highlights.length) {
      addExtras(existing.id, extras, update);
      if (!extras.highlights.length) update.hl = existing.hl;
    }
    items.put(finalize(update));
    merged++;
  }
  const favStore = t.objectStore('favicons');
  for (const [host, icon] of Object.entries(data.favicons || {})) putFaviconIfMissing(favStore, `https://${host}/`, icon);
  await finished(t);
  notifyChanged();
  return { added, merged };
}

// ---- trash: automatic cleanup keeps only what's needed to bring an item back ----
export async function trashCount() {
  const t = await tx('trash');
  return done(t.objectStore('trash').count());
}

/** Moves items to the trash: everything is deleted except title, url and save date. */
export async function moveToTrash(ids, reason = 'rule') {
  return (await trashItems(ids, reason)).removed.length;
}

/**
 * Same as moveToTrash, but returns everything that was removed so the caller can offer "undo"
 * (manual deletes): { removed: [{item, thumb, article}], trashIds }.
 */
export async function trashItems(ids, reason = 'manual') {
  const t = await tx([...ALL_ITEM_STORES, 'trash'], 'readwrite');
  const deletedAt = Date.now();
  const removed = [];
  const trashIds = [];
  for (const id of ids) {
    const item = await done(t.objectStore('items').get(id));
    if (!item) continue;
    t.objectStore('items').delete(id);
    const rel = await takeRelated(t, id);
    trashIds.push(await done(t.objectStore('trash').add({ title: item.title, url: item.url, time_added: item.time_added, deletedAt, reason })));
    removed.push({ item, ...rel });
  }
  await finished(t);
  if (removed.length) notifyChanged(removed.map(r => r.item.id));
  return { removed, trashIds };
}

/** Undoes trashItems: puts the full items back and drops their trash entries. */
export async function undoTrash({ removed, trashIds }) {
  const t = await tx([...ALL_ITEM_STORES, 'trash'], 'readwrite');
  for (const rel of removed) {
    t.objectStore('items').put(rel.item);
    putRelated(t, rel.item, rel);
  }
  for (const id of trashIds) t.objectStore('trash').delete(id);
  await finished(t);
  notifyChanged(removed.map(r => r.item.id));
}

/** Trash entries, most recently deleted first. */
export async function listTrash() {
  const t = await tx('trash');
  return (await done(t.objectStore('trash').index('deletedAt').getAll())).reverse();
}

/**
 * Brings entries back as new unread items (their text and thumbnail get downloaded again).
 * The save date becomes "now", so cleanup rules count their age from the restore.
 */
export async function restoreFromTrash(ids) {
  const t = await tx(['items', 'trash'], 'readwrite');
  const items = t.objectStore('items');
  let n = 0;
  for (const id of ids) {
    const row = await done(t.objectStore('trash').get(id));
    if (!row) continue;
    t.objectStore('trash').delete(id);
    if (await findByUrl(items, row.url)) continue;
    items.add(makeItem({ title: row.title, url: row.url, time_added: nowSeconds(), status: 'unread' }));
    n++;
  }
  await finished(t);
  notifyChanged();
  return n;
}

export async function deleteFromTrash(ids) {
  const t = await tx('trash', 'readwrite');
  for (const id of ids) t.objectStore('trash').delete(id);
  await finished(t);
  notifyChanged();
}

/** Deletes for good the trash entries removed before `beforeMs` (all of them if omitted). */
export async function purgeTrash(beforeMs = Infinity) {
  const t = await tx('trash', 'readwrite');
  const store = t.objectStore('trash');
  const keys = await done(store.index('deletedAt').getAllKeys(IDBKeyRange.upperBound(beforeMs, true)));
  for (const k of keys) store.delete(k);
  await finished(t);
  if (keys.length) notifyChanged();
  return keys.length;
}

export async function clearAll() {
  const stores = [...ALL_ITEM_STORES, 'favicons', 'trash'];
  const t = await tx(stores, 'readwrite');
  for (const s of stores) t.objectStore(s).clear();
  await finished(t);
  notifyChanged();
}

// ---- searchable text ----
/** Ids of items with a saved article but no searchable text yet (saved before v1.6, or from a backup). */
export async function idsMissingText() {
  const t = await tx(['items', 'texts']);
  const [items, have] = await Promise.all([done(t.objectStore('items').getAll()), done(t.objectStore('texts').getAllKeys())]);
  const known = new Set(have);
  return items.filter(i => i.hasArticle && !known.has(i.id)).map(i => i.id);
}

export async function setText(id, text) {
  const t = await tx('texts', 'readwrite');
  t.objectStore('texts').put({ id, text: searchText(text) });
  await finished(t);
}

/**
 * Rewrites searchable texts saved in the older, full format (v1.6–1.8) in the compact one.
 * Safe to run again: compact texts stay as they are. Returns how many were rewritten.
 */
export async function compactTexts() {
  const t = await tx('texts', 'readwrite');
  let n = 0;
  await new Promise((resolve, reject) => {
    const req = t.objectStore('texts').openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const compact = searchText(cur.value.text);
      if (compact !== cur.value.text) { cur.update({ id: cur.value.id, text: compact }); n++; }
      cur.continue();
    };
  });
  await finished(t);
  return n;
}

// ---- offline pictures ----
/** @returns {Promise<Map<string, Blob>>} original address -> stored picture */
export async function getImages(itemId) {
  const t = await tx('images');
  const rows = await done(t.objectStore('images').index('itemId').getAll(itemId));
  return new Map(rows.map(r => [r.url, r.blob]));
}

/**
 * Replaces the item's stored pictures. An empty list switches offline pictures off;
 * byUser marks that the user turned them off for this article.
 */
export async function setImages(itemId, pictures, { byUser = false } = {}) {
  const t = await tx(['items', 'images'], 'readwrite');
  const item = await done(t.objectStore('items').get(itemId));
  if (!item) { await finished(t); return null; }
  const store = t.objectStore('images');
  await deleteByItem(store, itemId);
  for (const p of pictures) store.add({ itemId, url: p.url, blob: p.blob });
  const bytes = pictures.reduce((n, p) => n + p.blob.size, 0);
  const updated = { ...item, images: pictures.length ? 1 : 0, imageBytes: bytes, noImages: pictures.length ? 0 : (byUser ? 1 : item.noImages || 0) };
  t.objectStore('items').put(updated);
  await finished(t);
  notifyChanged([itemId]);
  return updated;
}

/** The user switched this article's offline pictures off. */
export const deleteImages = itemId => setImages(itemId, [], { byUser: true });

/** Deletes every stored picture (keeps everything else). */
export async function deleteAllImages() {
  const t = await tx(['items', 'images'], 'readwrite');
  t.objectStore('images').clear();
  const items = t.objectStore('items');
  for (const item of await done(items.getAll())) if (item.images) items.put({ ...item, images: 0, imageBytes: 0 });
  await finished(t);
  notifyChanged();
}

// ---- highlights ----
/** Highlights of one item in reading order. */
export async function getHighlights(itemId) {
  const t = await tx('highlights');
  return (await done(t.objectStore('highlights').index('itemId').getAll(itemId))).sort((a, b) => a.start - b.start);
}

async function countHighlights(t, itemId) {
  const n = await done(t.objectStore('highlights').index('itemId').count(itemId));
  const item = await done(t.objectStore('items').get(itemId));
  if (item && item.hl !== n) t.objectStore('items').put({ ...item, hl: n });
}

/** Adds ({itemId, start, end, text, color, note}) or updates (with id) a highlight; returns it. */
export async function saveHighlight(h) {
  const t = await tx(['items', 'highlights'], 'readwrite');
  const { lost: _lost, ...clean } = h;
  const row = {
    ...clean,
    color: ['yellow', 'green', 'blue', 'pink'].includes(h.color) ? h.color : 'yellow',
    note: String(h.note || '').slice(0, 5000),
    created: h.created || Date.now(),
  };
  row.id = await done(t.objectStore('highlights').put(row));
  await countHighlights(t, row.itemId);
  await finished(t);
  notifyChanged([row.itemId]);
  return row;
}

export async function deleteHighlight(id) {
  const t = await tx(['items', 'highlights'], 'readwrite');
  const row = await done(t.objectStore('highlights').get(id));
  if (row) {
    t.objectStore('highlights').delete(id);
    await countHighlights(t, row.itemId);
  }
  await finished(t);
  if (row) notifyChanged([row.itemId]);
}

/**
 * Items whose saved text has "�" in it: pages downloaded before v1.6.1 with the wrong
 * character set. They're downloaded again to repair them.
 */
export async function itemsWithBrokenText() {
  // Walks the texts one by one (a cursor), so they are never all in memory at once.
  const t = await tx(['items', 'texts']);
  const broken = new Set();
  await new Promise((resolve, reject) => {
    const req = t.objectStore('texts').openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      if ((cur.value.text.match(/\uFFFD/g) || []).length >= 3) broken.add(cur.value.id);
      cur.continue();
    };
  });
  const items = await done(t.objectStore('items').getAll());
  return items.filter(i => broken.has(i.id) || (i.title || '').includes('\uFFFD'));
}

// ---- reading position ----
// Written often while reading, so it doesn't send change notices (nobody else shows it).
export async function getPosition(id) {
  const t = await tx('positions');
  return (await done(t.objectStore('positions').get(id)))?.at ?? 0;
}

/** at: 0–1, how far down the article. 0 forgets it. */
export async function setPosition(id, at) {
  const t = await tx('positions', 'readwrite');
  if (at > 0) t.objectStore('positions').put({ id, at: Math.round(at * 1000) / 1000 });
  else t.objectStore('positions').delete(id);
  await finished(t);
}
