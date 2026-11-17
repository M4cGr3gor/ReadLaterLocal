import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/lib/db.js';

const rec = (n, extra = {}) => ({
  title: `Item ${n}`, url: `https://site${n}.com/`, time_added: 1000 + n, tags: [], status: 'unread', ...extra,
});

beforeEach(async () => {
  await db.clearAll();
});

test('new items get v3 defaults and a detected kind', async () => {
  const { item } = await db.addItem(rec(1, { url: 'https://www.youtube.com/watch?v=abcdefghijk' }));
  assert.equal(item.kind, 'video');
  assert.equal(item.words, 0);
  assert.equal(item.note, '');
  assert.equal(item.expires, 0);
  assert.equal(item.collection, '');
});

test('setArticle stores the word count and makes the item an article', async () => {
  const { item } = await db.addItem(rec(1));
  await db.setArticle(item.id, new Blob(['x']), 900);
  const after = await db.getItem(item.id);
  assert.equal(after.words, 900);
  assert.equal(after.kind, 'article');
});

test('page can list oldest first and chain batches', async () => {
  await db.importRecords(Array.from({ length: 7 }, (_, i) => rec(i)));
  const p1 = await db.page({ order: 'oldest', limit: 3 });
  const p2 = await db.page({ order: 'oldest', after: p1.next, limit: 3 });
  const p3 = await db.page({ order: 'oldest', after: p2.next, limit: 3 });
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map(i => i.time_added), [1000, 1001, 1002, 1003, 1004, 1005, 1006]);
  assert.equal(p3.next, null);
});

test('oldest-first paging survives identical timestamps', async () => {
  await db.importRecords(Array.from({ length: 5 }, (_, i) => rec(i, { time_added: 7 })));
  const p1 = await db.page({ order: 'oldest', limit: 2 });
  const p2 = await db.page({ order: 'oldest', after: p1.next, limit: 2 });
  const p3 = await db.page({ order: 'oldest', after: p2.next, limit: 2 });
  assert.equal(new Set([...p1.items, ...p2.items, ...p3.items].map(i => i.id)).size, 5);
});

test('page filters by kind, collection and short reads', async () => {
  const a = (await db.addItem(rec(1))).item;
  const v = (await db.addItem(rec(2, { url: 'https://youtu.be/abcdefghijk' }))).item;
  const long = (await db.addItem(rec(3, { collection: 'c1' }))).item;
  await db.setArticle(a.id, new Blob(['x']), 500);
  await db.setArticle(long.id, new Blob(['x']), 5000);
  const ids = async o => (await db.page({ limit: 50, ...o })).items.map(i => i.id).sort();
  assert.deepEqual(await ids({ kind: 'video' }), [v.id]);
  assert.deepEqual(await ids({ kind: 'article' }), [a.id, long.id].sort());
  assert.deepEqual(await ids({ collection: 'c1' }), [long.id]);
  assert.deepEqual(await ids({ collection: '-' }), [a.id, v.id].sort());
  assert.deepEqual(await ids({ short: true }), [a.id]);
});

test('updateItems and deleteItems work on many items; restoreItems undoes the delete', async () => {
  const ids = [];
  for (let i = 1; i <= 3; i++) ids.push((await db.addItem(rec(i))).item.id);
  await db.updateItems(ids, item => ({ tags: [...item.tags, 'lote'], status: 'archive' }));
  assert.ok((await db.allItems()).every(i => i.status === 'archive' && i.tags.includes('lote')));
  const removed = await db.deleteItems(ids.slice(0, 2));
  assert.equal(removed.length, 2);
  assert.equal((await db.counts()).all, 1);
  await db.restoreItems(removed);
  assert.equal((await db.counts()).all, 3);
});

test('matchingIds and randomItem respect the filters', async () => {
  await db.addItem(rec(1));
  const b = (await db.addItem(rec(2, { status: 'archive' }))).item;
  assert.deepEqual(await db.matchingIds({ status: 'archive' }), [b.id]);
  assert.equal((await db.randomItem({ status: 'archive' })).id, b.id);
  assert.equal(await db.randomItem({ status: 'archive', query: 'nada-de-nada' }), null);
});

test('siteCounts and tagStats summarise sites and tags', async () => {
  await db.addItem(rec(1, { url: 'https://www.youtube.com/a', tags: ['vídeo'] }));
  await db.addItem(rec(2, { url: 'https://youtube.com/b', tags: ['vídeo', 'hw'] }));
  await db.addItem(rec(3, { url: 'https://github.com/c' }));
  assert.deepEqual(await db.siteCounts(), [{ site: 'youtube.com', count: 2 }, { site: 'github.com', count: 1 }]);
  const stats = await db.tagStats();
  assert.equal(stats.siteTags.get('youtube.com').get('vídeo'), 2);
  assert.deepEqual(stats.allTags.sort(), ['hw', 'vídeo']);
});

test('clearCollection leaves its items without collection', async () => {
  const { item } = await db.addItem(rec(1, { collection: 'c9' }));
  await db.clearCollection('c9');
  assert.equal((await db.getItem(item.id)).collection, '');
});

test('notes are searchable and survive a full backup round-trip', async () => {
  await db.addItem(rec(1, { note: 'Para el proyecto del reloj', collection: 'c1' }));
  assert.equal((await db.page({ query: 'reloj', limit: 10 })).items.length, 1);
  const backup = await db.exportFull();
  await db.clearAll();
  await db.importFull(backup);
  const back = await db.getByUrl('https://site1.com/');
  assert.equal(back.note, 'Para el proyecto del reloj');
  assert.equal(back.collection, 'c1');
});
