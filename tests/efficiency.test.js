import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/lib/db.js';

const rec = (n, extra = {}) => ({
  title: `Item ${n}`, url: `https://site${n % 3}.com/p${n}`, time_added: 1000 + n, tags: [], status: 'unread', ...extra,
});

beforeEach(async () => {
  await db.clearAll();
});

test('counts come from the indexes and match the items', async () => {
  await db.importRecords([
    rec(1), rec(2, { status: 'archive' }), rec(3, { favorite: 1 }), rec(4, { status: 'archive', favorite: 1 }), rec(5),
  ]);
  const [first] = await db.recent(1);
  await db.trashItems([first.id]);
  assert.deepEqual(await db.counts(), { unread: 2, archive: 2, favorite: 2, all: 4, trash: 1 });
  assert.equal(await db.unreadCount(), 2);
});

test('the tags/sites bar comes from one pass and keeps the old answers', async () => {
  await db.importRecords([
    rec(1, { tags: ['a', 'b'] }), rec(2, { tags: ['a'] }), rec(3, { tags: ['c'] }), rec(4), rec(5, { tags: ['a'] }),
  ]);
  const f = await db.facetStats();
  assert.deepEqual(f.tags, [{ tag: 'a', count: 3 }, { tag: 'b', count: 1 }, { tag: 'c', count: 1 }]);
  assert.deepEqual(f.sites, [{ site: 'site1.com', count: 2 }, { site: 'site2.com', count: 2 }, { site: 'site0.com', count: 1 }]);
  assert.deepEqual(f.allTags, ['a', 'b', 'c']);
  assert.deepEqual(Object.fromEntries(f.siteTags.get('site2.com')), { a: 2 });
  assert.deepEqual(Object.fromEntries(f.siteTags.get('site1.com')), { a: 1, b: 1 });
  assert.deepEqual(await db.allTags(), f.tags);
  assert.deepEqual(await db.siteCounts(), f.sites);
});

test('searchable text keeps each word once, without accents, capitals or punctuation around it', () => {
  assert.equal(db.searchText('El Niño, el niño y (el) NIÑO. Node.js y C++'), 'el nino y node.js c');
  assert.equal(db.searchText(''), '');
});

test('old full texts are compacted once and search still finds the same items', async () => {
  await db.importRecords([rec(1), rec(2)]);
  const [b, a] = await db.recent(2);
  const prose = 'La extensión guarda artículos. Los artículos se leen sin conexión, y la búsqueda encuentra palabras.';
  await db.setText(a.id, prose);
  await db.setText(b.id, 'Otro texto distinto sobre recetas de cocina.');
  // Simulate texts saved by v1.6–1.8 (the whole text, normalised).
  const req = indexedDB.open('read-later-local');
  const raw = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const t = raw.transaction('texts', 'readwrite');
  t.objectStore('texts').put({ id: a.id, text: 'la extension guarda articulos. los articulos se leen sin conexion, y la busqueda encuentra palabras.' });
  await new Promise(r => { t.oncomplete = r; });
  raw.close();

  const before = (await db.page({ status: 'all', query: 'articulos conexion' })).items.map(i => i.id);
  assert.equal(await db.compactTexts(), 1);
  assert.equal(await db.compactTexts(), 0, 'running it again changes nothing');
  const after = (await db.page({ status: 'all', query: 'articulos conexion' })).items.map(i => i.id);
  assert.deepEqual(after, before);
  assert.deepEqual(after, [a.id]);
  // Punctuation typed in the search doesn't get in the way, and partial words still match.
  assert.deepEqual((await db.page({ status: 'all', query: 'palabras.' })).items.map(i => i.id), [a.id]);
  assert.deepEqual((await db.page({ status: 'all', query: 'cocin' })).items.map(i => i.id), [b.id]);
});

test('broken texts are still detected after compaction', async () => {
  await db.importRecords([rec(1)]);
  const [item] = await db.recent(1);
  await db.setText(item.id, 'informaci�n est� en la p�gina de la informaci�n');
  assert.deepEqual((await db.itemsWithBrokenText()).map(i => i.id), [item.id]);
});
