import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/lib/db.js';

const rec = (n, extra = {}) => ({
  title: `Item ${n}`, url: `https://site${n}.com/`, time_added: 1000 + n, tags: [], status: 'unread', ...extra,
});
const all = q => db.page({ status: 'all', query: q ?? '', after: null, limit: 100 });

beforeEach(async () => {
  await db.clearAll();
});

test('addItem does not duplicate the same url', async () => {
  const a = await db.addItem(rec(1));
  assert.equal(a.existed, false);
  const b = await db.addItem(rec(1, { title: 'Otro' }));
  assert.equal(b.existed, true);
  assert.equal(b.item.title, 'Item 1');
  assert.equal((await db.counts()).all, 1);
});

test('new items get v2 defaults', async () => {
  const { item } = await db.addItem(rec(1));
  assert.equal(item.favorite, 0);
  assert.equal(item.hasArticle, 0);
  assert.equal(item.fetchState, 0);
  assert.deepEqual(item.tags, []);
});

test('favicons are stored once per host, not per item', async () => {
  await db.addItem(rec(1, { url: 'https://www.a.com/1', favicon: 'data:image/png;base64,AAA' }));
  await db.addItem(rec(2, { url: 'https://a.com/2', favicon: 'data:image/png;base64,BBB' }));
  const items = (await all()).items;
  assert.ok(items.every(i => !('favicon' in i)));
  assert.equal(await db.getFavicon('a.com'), 'data:image/png;base64,AAA');
  assert.equal((await db.storageStats()).favicons, 1);
});

test('recent returns newest first and respects the limit', async () => {
  for (let i = 1; i <= 15; i++) await db.addItem(rec(i));
  const r = await db.recent(10);
  assert.equal(r.length, 10);
  assert.equal(r[0].title, 'Item 15');
  assert.equal(r[9].title, 'Item 6');
});

test('page chains batches without repeats, newest first', async () => {
  await db.importRecords(Array.from({ length: 75 }, (_, i) => rec(i)));
  const seen = [];
  let after = null;
  let pages = 0;
  do {
    const { items, next } = await db.page({ status: 'all', query: '', after, limit: 30 });
    seen.push(...items.map(i => i.time_added));
    after = next;
    pages++;
  } while (after);
  assert.equal(pages, 3);
  assert.equal(seen.length, 75);
  assert.equal(new Set(seen).size, 75);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
});

test('page handles items with identical time_added', async () => {
  await db.importRecords(Array.from({ length: 5 }, (_, i) => rec(i, { time_added: 500 })));
  const p1 = await db.page({ status: 'all', query: '', after: null, limit: 2 });
  const p2 = await db.page({ status: 'all', query: '', after: p1.next, limit: 2 });
  const p3 = await db.page({ status: 'all', query: '', after: p2.next, limit: 2 });
  const ids = [...p1.items, ...p2.items, ...p3.items].map(i => i.id);
  assert.equal(new Set(ids).size, 5);
  assert.equal(p3.next, null);
});

test('page filters by status, favorites, tags and accent-insensitive text', async () => {
  await db.addItem(rec(1, { title: 'Guía de Flexbox', tags: ['css'] }));
  await db.addItem(rec(2, { status: 'archive', tags: ['css', 'old'] }));
  const { item } = await db.addItem(rec(3));
  await db.updateItem(item.id, { favorite: 1 });
  const titles = r => r.items.map(i => i.title);
  assert.deepEqual(titles(await db.page({ status: 'archive', query: '', after: null, limit: 30 })), ['Item 2']);
  assert.deepEqual(titles(await db.page({ status: 'favorite', query: '', after: null, limit: 30 })), ['Item 3']);
  assert.deepEqual(titles(await db.page({ status: 'unread', query: 'guia', after: null, limit: 30 })), ['Guía de Flexbox']);
  assert.deepEqual(titles(await all('tag:css')), ['Item 2', 'Guía de Flexbox']);
  assert.deepEqual(titles(await all('tag:css tag:old')), ['Item 2']);
});

test('counts by status and favorites', async () => {
  await db.addItem(rec(1, { favorite: 1 }));
  await db.addItem(rec(2, { status: 'archive' }));
  assert.deepEqual(await db.counts(), { unread: 1, archive: 1, favorite: 1, all: 2, trash: 0 });
});

test('allTags counts tag usage, most used first', async () => {
  await db.addItem(rec(1, { tags: ['css', 'web'] }));
  await db.addItem(rec(2, { tags: ['css'] }));
  assert.deepEqual(await db.allTags(), [{ tag: 'css', count: 2 }, { tag: 'web', count: 1 }]);
});

test('importRecords skips existing urls and repeats inside the file', async () => {
  await db.addItem(rec(1));
  const r = await db.importRecords([rec(1), rec(2), rec(2), rec(3)]);
  assert.deepEqual(r, { added: 2, duplicates: 2 });
  const again = await db.importRecords([rec(1), rec(2), rec(3)]);
  assert.deepEqual(again, { added: 0, duplicates: 3 });
});

test('articles: setArticle flags the item, deleteItem/restoreItem carry the article', async () => {
  const { item } = await db.addItem(rec(1), new Blob(['t']));
  await db.setArticle(item.id, new Blob(['gz']));
  assert.equal((await db.getByUrl(item.url)).hasArticle, 1);
  assert.equal((await db.getByUrl(item.url)).fetchState, 1);
  assert.ok(await db.getArticle(item.id));
  const removed = await db.deleteItem(item.id);
  assert.equal(await db.getArticle(item.id), null);
  assert.equal(await db.getThumb(item.id), null);
  await db.restoreItem(removed.item, removed.thumb, removed.article);
  assert.ok(await db.getArticle(item.id));
  assert.ok(await db.getThumb(item.id));
});

test('deleteArchivedArticles frees article space only for archived items', async () => {
  const a = (await db.addItem(rec(1))).item;
  const b = (await db.addItem(rec(2, { status: 'archive' }))).item;
  await db.setArticle(a.id, new Blob(['x']));
  await db.setArticle(b.id, new Blob(['y']));
  assert.equal(await db.deleteArchivedArticles(), 1);
  assert.ok(await db.getArticle(a.id));
  assert.equal(await db.getArticle(b.id), null);
  assert.equal((await db.getByUrl(b.url)).hasArticle, 0);
});

test('itemsToFetch returns pending items, failed ones only when asked', async () => {
  const a = (await db.addItem(rec(1))).item;
  const b = (await db.addItem(rec(2))).item;
  const c = (await db.addItem(rec(3))).item;
  await db.setArticle(a.id, new Blob(['x']));
  await db.updateItem(b.id, { fetchState: 2 });
  assert.deepEqual((await db.itemsToFetch(false)).map(i => i.id), [c.id]);
  assert.deepEqual((await db.itemsToFetch(true)).map(i => i.id).sort(), [b.id, c.id].sort());
});

test('storageStats sums sizes of thumbnails and articles', async () => {
  const { item } = await db.addItem(rec(1), new Blob(['12345']));
  await db.setArticle(item.id, new Blob(['123']));
  const s = await db.storageStats();
  assert.equal(s.items, 1);
  assert.equal(s.thumbs, 1);
  assert.equal(s.thumbBytes, 5);
  assert.equal(s.articles, 1);
  assert.equal(s.articleBytes, 3);
});

test('full backup round-trip merges instead of overwriting', async () => {
  const { item } = await db.addItem(rec(1, { tags: ['a'] }), new Blob(['thumb'], { type: 'image/webp' }));
  await db.setArticle(item.id, new Blob(['article']));
  await db.updateItem(item.id, { favorite: 1 });
  await db.addItem(rec(2));
  const backup = await db.exportFull();
  assert.equal(backup.format, 'read-later-local');
  assert.equal(backup.items.length, 2);

  await db.clearAll();
  await db.addItem(rec(1, { title: 'Local title', tags: ['b'] }));
  const res = await db.importFull(backup);
  assert.deepEqual(res, { added: 1, merged: 1 });
  const merged = await db.getByUrl('https://site1.com/');
  assert.equal(merged.title, 'Local title');
  assert.deepEqual(merged.tags.sort(), ['a', 'b']);
  assert.equal(merged.favorite, 1);
  assert.equal(merged.hasArticle, 1);
  assert.equal(await (await db.getArticle(merged.id)).text(), 'article');
  assert.equal(await (await db.getThumb(merged.id)).text(), 'thumb');
});

test('updateItem changes status and allItems lists newest first', async () => {
  const { item } = await db.addItem(rec(1));
  await db.addItem(rec(2));
  await db.updateItem(item.id, { status: 'archive' });
  const list = await db.allItems();
  assert.deepEqual(list.map(i => [i.title, i.status]), [['Item 2', 'unread'], ['Item 1', 'archive']]);
});
