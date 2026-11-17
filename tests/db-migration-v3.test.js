import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A v3 database as version 1.4.0 left it (with an item in the old "Read soon" list).
function createV3() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('read-later-local', 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      const items = d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      items.createIndex('url', 'url', { unique: true });
      items.createIndex('time_added', 'time_added');
      items.createIndex('status_time', ['status', 'time_added']);
      items.createIndex('fav_time', ['favorite', 'time_added']);
      d.createObjectStore('thumbs', { keyPath: 'id' });
      d.createObjectStore('articles', { keyPath: 'id' });
      d.createObjectStore('favicons', { keyPath: 'host' });
      items.add({ title: 'Art', url: 'https://a.com/p', time_added: 10, tags: ['x'], status: 'unread', favorite: 1, hasArticle: 1, fetchState: 1, words: 400, note: 'n', soon: 1, collection: 'c1', kind: 'article' });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

test('opening a v3 database drops "read soon", adds expires and the trash', async () => {
  await createV3();
  const db = await import('../src/lib/db.js');
  const [art] = await db.allItems();
  assert.equal(art.soon, undefined);
  assert.equal(art.expires, 0);
  assert.equal(art.note, 'n');
  assert.equal(art.collection, 'c1');
  assert.equal(art.words, 400);
  // v6: the same page under another address is recognised, and positions can be kept.
  assert.equal(art.ukey, 'a.com/p');
  assert.equal((await db.getByUrl('http://www.a.com/p/?utm_source=x'))?.id, art.id);
  await db.setPosition(art.id, 0.5);
  assert.equal(await db.getPosition(art.id), 0.5);
  assert.equal(await db.trashCount(), 0);
  assert.equal(await db.moveToTrash([art.id]), 1);
  assert.equal(await db.trashCount(), 1);
});
