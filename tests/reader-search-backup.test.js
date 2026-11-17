import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import * as db from '../src/lib/db.js';
import { imageUrls } from '../src/lib/images.js';
import { locate } from '../src/reader/highlights.js';

const rec = (n, extra = {}) => ({
  title: `Item ${n}`, url: `https://site${n}.com/`, time_added: 1000 + n, tags: [], status: 'unread', ...extra,
});
const ids = async opts => (await db.page({ limit: 50, ...opts })).items.map(i => i.id).sort();

beforeEach(async () => {
  await db.clearAll();
});

test('full-text search finds words in the article, accent-insensitive, and flags it', async () => {
  const a = (await db.addItem(rec(1))).item;
  const b = (await db.addItem(rec(2))).item;
  await db.setArticle(a.id, new Blob(['x']), 300, 'La configuración del Router en Angular');
  await db.setArticle(b.id, new Blob(['x']), 300, 'Recetas de cocina');
  assert.deepEqual(await ids({ query: 'configuracion router' }), [a.id]);
  assert.deepEqual(await ids({ query: 'router cocina' }), []);
  const [hit] = (await db.page({ query: 'ANGULAR' })).items;
  assert.equal(hit._inText, true);
  const [byTitle] = (await db.page({ query: 'item 2' })).items;
  assert.equal(byTitle._inText, undefined);
  assert.deepEqual(await db.matchingIds({ query: 'recetas' }), [b.id]);
});

test('texts can be backfilled and are removed with the item', async () => {
  const a = (await db.addItem(rec(1))).item;
  await db.setArticle(a.id, new Blob(['x']), 300);
  assert.deepEqual(await db.idsMissingText(), [a.id]);
  await db.setText(a.id, 'Texto  Antiguo');
  assert.deepEqual(await db.idsMissingText(), []);
  assert.deepEqual(await ids({ query: 'antiguo' }), [a.id]);
  await db.deleteItem(a.id);
  assert.equal((await db.storageStats()).texts, 0);
});

test('offline pictures are stored per item and deleted when archiving', async () => {
  const a = (await db.addItem(rec(1))).item;
  const updated = await db.setImages(a.id, [{ url: 'https://x/1.jpg', blob: new Blob(['1234']) }, { url: 'https://x/2.jpg', blob: new Blob(['56']) }]);
  assert.equal(updated.images, 1);
  assert.equal(updated.imageBytes, 6);
  assert.equal((await db.getImages(a.id)).size, 2);
  const archived = await db.updateItem(a.id, { status: 'archive' });
  assert.equal(archived.images, 0);
  assert.equal((await db.getImages(a.id)).size, 0);
});

test('highlights keep a count on the item and go away with it, undo brings them back', async () => {
  const a = (await db.addItem(rec(1))).item;
  const h1 = await db.saveHighlight({ itemId: a.id, start: 10, end: 20, text: 'abcdefghij', color: 'green', note: 'nota' });
  await db.saveHighlight({ itemId: a.id, start: 0, end: 5, text: 'hola ', color: 'bad' });
  assert.equal((await db.getItem(a.id)).hl, 2);
  const list = await db.getHighlights(a.id);
  assert.deepEqual(list.map(h => h.start), [0, 10]);
  assert.equal(list[0].color, 'yellow');
  await db.deleteHighlight(h1.id);
  assert.equal((await db.getItem(a.id)).hl, 1);
  const trashed = await db.trashItems([a.id]);
  assert.equal((await db.getHighlights(a.id)).length, 0);
  await db.undoTrash(trashed);
  assert.equal((await db.getHighlights(a.id)).length, 1);
});

test('full backups carry highlights always and pictures only when asked', async () => {
  const a = (await db.addItem(rec(1))).item;
  await db.saveHighlight({ itemId: a.id, start: 0, end: 4, text: 'Hola', color: 'blue', note: 'n' });
  await db.setImages(a.id, [{ url: 'https://x/1.jpg', blob: new Blob(['1234'], { type: 'image/webp' }) }]);
  const lite = await db.exportFull();
  assert.equal(lite.items[0].images, undefined);
  assert.equal(lite.items[0].highlights.length, 1);
  const full = await db.exportFull({ images: true });
  assert.equal(full.items[0].images.length, 1);
  await db.clearAll();
  await db.importFull(full);
  const [back] = await db.allItems();
  assert.equal(back.hl, 1);
  assert.equal(back.images, 1);
  assert.equal((await db.getHighlights(back.id))[0].note, 'n');
  assert.equal((await db.getImages(back.id)).size, 1);
});

test('highlights are found again when the text moved', () => {
  const h = { start: 4, end: 9, text: 'mundo' };
  assert.deepEqual(locate('Hola mundo', { ...h, start: 5, end: 10 }), { start: 5, end: 10 });
  assert.deepEqual(locate('Hola, mundo y mundo', h), { start: 6, end: 11 });
  assert.equal(locate('Nada que ver', h), null);
});

test('picture addresses come from the article html, http(s) only and without repeats', () => {
  const html = '<p><img src="https://a.com/1.jpg"><img src="https://a.com/1.jpg"><img src="data:x"><img src="http://b.com/2.png"></p>';
  assert.deepEqual(imageUrls(html, DOMParser), ['https://a.com/1.jpg', 'http://b.com/2.png']);
});

test('pages are decoded with the character set they declare', async () => {
  const { decodeHtml } = await import('../src/lib/fetcher.js');
  const latin1 = Uint8Array.from([...'<p>características, año</p>'].map(c => c.charCodeAt(0)));
  assert.equal(decodeHtml(latin1.buffer, 'text/html; charset=ISO-8859-1'), '<p>características, año</p>');
  const meta = Uint8Array.from([...'<meta charset="windows-1252"><p>González</p>'].map(c => c.charCodeAt(0)));
  assert.match(decodeHtml(meta.buffer, 'text/html'), /González/);
  const utf8 = new TextEncoder().encode('<p>máquina virtual</p>');
  assert.equal(decodeHtml(utf8.buffer, 'text/html'), '<p>máquina virtual</p>');
  const undeclared = Uint8Array.from([...'<p>á é í ó ú</p>'].map(c => c.charCodeAt(0)));
  assert.equal(decodeHtml(undeclared.buffer, 'text/html'), '<p>á é í ó ú</p>');
});

test('articles saved with the wrong character set are found for repair', async () => {
  const a = (await db.addItem(rec(1))).item;
  const b = (await db.addItem(rec(2, { title: 'Caracter�sticas' }))).item;
  const c = (await db.addItem(rec(3))).item;
  await db.setArticle(a.id, new Blob(['x']), 300, 'Despu�s de la actualizaci�n, ca�das');
  await db.setArticle(c.id, new Blob(['x']), 300, 'Texto correcto');
  assert.deepEqual((await db.itemsWithBrokenText()).map(i => i.id).sort(), [a.id, b.id].sort());
});

test('removing an article\'s pictures by hand is remembered', async () => {
  const a = (await db.addItem(rec(1))).item;
  await db.setImages(a.id, [{ url: 'https://x/1.jpg', blob: new Blob(['1']) }]);
  assert.equal((await db.deleteImages(a.id)).noImages, 1);
  assert.equal((await db.setImages(a.id, [{ url: 'https://x/1.jpg', blob: new Blob(['1']) }])).noImages, 0);
});

test('file names from titles are safe on every system', async () => {
  const { safeFileName } = await import('../src/lib/files.js');
  assert.equal(safeFileName('¿Qué es un webhook? <guía>: "1/2"', 'html'), '¿Qué es un webhook guía 1 2.html');
  assert.equal(safeFileName('   ', 'html'), 'articulo.html');
  assert.equal(safeFileName('a'.repeat(200), 'html').length, 85);
  assert.equal(safeFileName('Título final. ', 'html'), 'Título final.html');
});
