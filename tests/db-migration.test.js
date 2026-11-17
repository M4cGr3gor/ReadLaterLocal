import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Build a v1 database exactly as version 1.0.0 of the extension did.
function createV1() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('read-later-local', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      const items = d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      items.createIndex('url', 'url', { unique: true });
      items.createIndex('time_added', 'time_added');
      items.createIndex('status_time', ['status', 'time_added']);
      d.createObjectStore('thumbs', { keyPath: 'id' });
      items.add({ title: 'A', url: 'https://www.a.com/1', time_added: 10, tags: 'x|Y', status: 'unread', favicon: 'data:image/png;base64,AAA' });
      items.add({ title: 'B', url: 'https://b.com/', time_added: 20, tags: '', status: 'archive' });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

test('opening a v1 database migrates items to v2 without losing data', async () => {
  await createV1();
  const db = await import('../src/lib/db.js');
  const items = await db.allItems();
  assert.equal(items.length, 2);
  const a = items.find(i => i.title === 'A');
  assert.deepEqual(a.tags, ['x', 'y']);
  assert.equal(a.favorite, 0);
  assert.equal(a.hasArticle, 0);
  assert.equal(a.fetchState, 0);
  assert.ok(!('favicon' in a));
  assert.equal(await db.getFavicon('a.com'), 'data:image/png;base64,AAA');
  assert.deepEqual(await db.counts(), { unread: 1, archive: 1, favorite: 0, all: 2, trash: 0 });
  assert.equal(a.kind, 'unknown');
  assert.equal(a.words, 0);
  assert.equal(a.note, '');
  assert.equal(a.collection, '');
});
