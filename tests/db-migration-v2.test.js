import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A v2 database as version 1.3.0 left it (with a saved article).
function createV2() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('read-later-local', 2);
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
      items.add({ title: 'Art', url: 'https://a.com/p', time_added: 10, tags: ['x'], status: 'unread', favorite: 1, hasArticle: 1, fetchState: 1 });
      items.add({ title: 'Vid', url: 'https://www.youtube.com/watch?v=abcdefghijk', time_added: 20, tags: [], status: 'unread', favorite: 0, hasArticle: 0, fetchState: 0 });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

test('opening a v2 database adds the v3 fields and keeps everything else', async () => {
  await createV2();
  const db = await import('../src/lib/db.js');
  const items = await db.allItems();
  const art = items.find(i => i.title === 'Art');
  const vid = items.find(i => i.title === 'Vid');
  assert.equal(art.kind, 'article');
  assert.equal(art.favorite, 1);
  assert.deepEqual(art.tags, ['x']);
  assert.equal(art.hasArticle, 1);
  assert.equal(vid.kind, 'video');
  assert.equal(vid.soon, undefined);
  assert.equal(vid.expires, 0);
  assert.equal(vid.collection, '');
});
