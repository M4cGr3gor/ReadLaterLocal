import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/lib/db.js';

const rec = (n, extra = {}) => ({
  title: `Item ${n}`, url: `https://site${n}.com/`, time_added: 1000 + n, tags: ['x'], status: 'archive', ...extra,
});

beforeEach(async () => {
  await db.clearAll();
});

test('moving to the trash keeps only title, url and save date', async () => {
  const { item } = await db.addItem(rec(1, { note: 'nota', collection: 'c1', favorite: 1 }), new Blob(['img']));
  await db.setArticle(item.id, new Blob(['texto']), 300);
  assert.equal(await db.moveToTrash([item.id, 999]), 1);
  assert.equal(await db.getItem(item.id), null);
  assert.equal(await db.getThumb(item.id), null);
  assert.equal(await db.getArticle(item.id), null);
  const [row] = await db.listTrash();
  assert.deepEqual(Object.keys(row).sort(), ['deletedAt', 'id', 'reason', 'time_added', 'title', 'url']);
  assert.equal(row.title, 'Item 1');
  assert.deepEqual(await db.counts(), { unread: 0, archive: 0, favorite: 0, all: 0, trash: 1 });
});

test('restoring brings the item back as unread and pending download', async () => {
  const { item } = await db.addItem(rec(1));
  await db.moveToTrash([item.id]);
  const [row] = await db.listTrash();
  assert.equal(await db.restoreFromTrash([row.id]), 1);
  const [back] = await db.allItems();
  assert.equal(back.url, 'https://site1.com/');
  assert.ok(Math.abs(back.time_added - Date.now() / 1000) < 5, 'save date becomes the restore date');
  assert.equal(back.status, 'unread');
  assert.equal(back.fetchState, 0);
  assert.deepEqual(back.tags, []);
  assert.equal(await db.trashCount(), 0);
});

test('restoring an address that was saved again only clears the trash entry', async () => {
  const { item } = await db.addItem(rec(1));
  await db.moveToTrash([item.id]);
  await db.addItem(rec(1, { title: 'Again' }));
  const [row] = await db.listTrash();
  assert.equal(await db.restoreFromTrash([row.id]), 0);
  assert.equal((await db.allItems()).length, 1);
  assert.equal(await db.trashCount(), 0);
});

test('purge deletes only entries older than the limit; no limit empties it', async () => {
  for (let i = 1; i <= 3; i++) await db.addItem(rec(i));
  const ids = (await db.allItems()).map(i => i.id);
  await db.moveToTrash(ids.slice(0, 2));
  const cut = Date.now() + 1;
  await new Promise(r => setTimeout(r, 5));
  await db.moveToTrash(ids.slice(2));
  assert.equal(await db.purgeTrash(cut), 2);
  assert.equal(await db.trashCount(), 1);
  assert.equal(await db.purgeTrash(), 1);
  assert.equal(await db.trashCount(), 0);
});

test('manual delete goes to the trash and undo brings the full item back', async () => {
  const { item } = await db.addItem(rec(1, { note: 'nota', favorite: 1 }), new Blob(['img']));
  await db.setArticle(item.id, new Blob(['texto']), 300);
  const trashed = await db.trashItems([item.id]);
  assert.equal(await db.getItem(item.id), null);
  assert.equal((await db.listTrash())[0].reason, 'manual');
  await db.undoTrash(trashed);
  const back = await db.getItem(item.id);
  assert.equal(back.note, 'nota');
  assert.equal(back.favorite, 1);
  assert.equal(back.hasArticle, 1);
  assert.ok(await db.getThumb(item.id));
  assert.ok(await db.getArticle(item.id));
  assert.equal(await db.trashCount(), 0);
});

test('expires is kept as whole seconds and 0 means never', async () => {
  const { item } = await db.addItem(rec(1));
  assert.equal(item.expires, 0);
  assert.equal((await db.updateItem(item.id, { expires: 1234.7 })).expires, 1234);
  assert.equal((await db.updateItem(item.id, { expires: -5 })).expires, 0);
});
