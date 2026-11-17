import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import * as db from '../src/lib/db.js';
import { cleanUrl, urlKey } from '../src/lib/urls.js';
import { articleMarkdown, htmlToMarkdown, linkMarkdown, linksMarkdown } from '../src/lib/markdown.js';
import { pickVoice } from '../src/reader/tts.js';

const rec = (url, extra = {}) => ({ title: 'T', url, time_added: 1000, tags: [], status: 'unread', ...extra });

beforeEach(async () => {
  await db.clearAll();
});

// ---- the same page under another address ----
test('tracking parameters are removed and everything else is kept', () => {
  assert.equal(cleanUrl('https://a.com/p?utm_source=x&id=5&fbclid=abc#top'), 'https://a.com/p?id=5#top');
  assert.equal(cleanUrl('https://a.com/p?utm_medium=mail'), 'https://a.com/p');
  assert.equal(cleanUrl('https://a.com/p?si=keep'), 'https://a.com/p?si=keep', '"si" only on YouTube/Spotify');
  assert.equal(cleanUrl('https://open.spotify.com/track/1?si=abc'), 'https://open.spotify.com/track/1');
  assert.equal(cleanUrl('https://a.com/p?q=1'), 'https://a.com/p?q=1');
  assert.equal(cleanUrl('not a url'), 'not a url');
});

test('the key ignores www, m., http/https, trailing slash, anchors and parameter order', () => {
  const k = urlKey('https://a.com/p?x=1&y=2');
  for (const u of ['http://www.a.com/p/?y=2&x=1', 'https://m.a.com/p?x=1&y=2#section', 'https://a.com/p?x=1&utm_source=n&y=2']) {
    assert.equal(urlKey(u), k, u);
  }
  assert.notEqual(urlKey('https://a.com/p?x=2'), k, 'different parameters are different pages');
  assert.notEqual(urlKey('https://a.com/q'), k);
  assert.equal(urlKey('https://app.com/#/inbox'), 'app.com/#/inbox', 'web-app routes keep their #/');
  assert.equal(urlKey('https://youtu.be/dQw4w9WgXcQ?si=1'), urlKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30'));
});

test('saving the same page with another address finds the one already saved', async () => {
  const first = await db.addItem(rec('https://www.a.com/article/?utm_source=newsletter'));
  assert.equal(first.existed, false);
  assert.equal(first.item.url, 'https://www.a.com/article/', 'stored without the tracking part');
  for (const u of ['https://a.com/article', 'http://m.a.com/article/#comments', 'https://www.a.com/article/?fbclid=1']) {
    const again = await db.addItem(rec(u));
    assert.equal(again.existed, true, u);
    assert.equal(again.item.id, first.item.id);
    assert.equal((await db.getByUrl(u))?.id, first.item.id, `already saved: ${u}`);
  }
  assert.equal((await db.counts()).all, 1);
});

test('imports skip pages already saved under another address', async () => {
  await db.addItem(rec('https://a.com/x'));
  const res = await db.importRecords([rec('https://www.a.com/x/'), rec('https://b.com/y?utm_campaign=z'), rec('https://b.com/y')]);
  assert.deepEqual(res, { added: 1, duplicates: 2 });
});

// ---- several tabs at once ----
test('saving several pages: one notice, duplicates counted apart', async () => {
  await db.addItem(rec('https://a.com/1'));
  const sent = [];
  globalThis.browser = { runtime: { sendMessage: async m => { sent.push(m); } } };
  try {
    const res = await db.addItems([rec('https://a.com/1?utm_source=x'), rec('https://b.com/2'), rec('https://c.com/3'), rec('https://www.c.com/3/')]);
    assert.equal(res.added.length, 2);
    assert.equal(res.existed.length, 1);
    assert.equal(sent.length, 1, 'a single change notice for the whole batch');
    assert.deepEqual(sent[0].ids.sort(), res.added.map(i => i.id).sort());
  } finally {
    delete globalThis.browser;
  }
});

// ---- reading position ----
test('the reading position is kept per item, forgotten at 0 and with the item', async () => {
  const { item } = await db.addItem(rec('https://a.com/long'));
  assert.equal(await db.getPosition(item.id), 0);
  await db.setPosition(item.id, 0.4567);
  assert.equal(await db.getPosition(item.id), 0.457);
  await db.setPosition(item.id, 0);
  assert.equal(await db.getPosition(item.id), 0);
  await db.setPosition(item.id, 0.5);
  await db.trashItems([item.id]);
  assert.equal(await db.getPosition(item.id), 0, 'deleted with the item');
});

// ---- Markdown ----
test('a link as Markdown escapes brackets in the title', () => {
  assert.equal(linkMarkdown({ title: 'Guía [2025] (nueva)', url: 'https://a.com/p (1)' }), '[Guía \\[2025\\] (nueva)](https://a.com/p%20%281%29)');
});

test('article HTML becomes readable Markdown', () => {
  const html = `<h2>Título</h2><p>Texto con <strong>negrita</strong>, <em>cursiva</em>, <code>a*b</code> y un
    <a href="https://x.com/a">enlace</a>.</p><ul><li>uno</li><li><p>dos</p><ol><li>a</li><li>b</li></ol></li></ul>
    <blockquote><p>Cita</p><p>larga</p></blockquote><pre><code>if (a) {\n  b();\n}</code></pre>
    <img src="https://x.com/i.png" alt="foto"><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table><hr>`;
  const md = htmlToMarkdown(html, DOMParser);
  assert.equal(md, [
    '## Título',
    'Texto con **negrita**, *cursiva*, `a*b` y un [enlace](https://x.com/a).',
    '- uno\n- dos\n\n  1. a\n  2. b',
    '> Cita\n>\n> larga',
    '```\nif (a) {\n  b();\n}\n```',
    '![foto](https://x.com/i.png)',
    '| A | B |\n| --- | --- |\n| 1 | 2\\|3 |',
    '---',
  ].join('\n\n'));
});

test('the article note has its details on top and the highlights at the end', () => {
  const item = { title: 'T', url: 'https://a.com/p', time_added: 1_700_000_000, tags: ['css', 'web dev'], note: 'para el lunes' };
  const md = articleMarkdown(item, { title: 'Un "título"', byline: 'Ana', siteName: 'A', html: '<p>Hola</p>' },
    [{ text: 'una frase', note: 'mi nota' }], { highlights: 'Subrayados' }, DOMParser);
  assert.equal(md, [
    '---\ntitle: "Un \\"título\\""\nurl: "https://a.com/p"\nsaved: 2023-11-14\nauthor: "Ana"\ntags: ["css", "web dev"]\nnote: "para el lunes"\n---',
    '# Un "título"',
    'A · <https://a.com/p>',
    'Hola',
    '## Subrayados',
    '> una frase\n\nmi nota',
  ].join('\n\n') + '\n');
});

test('the list of links marks archived ones and turns tags into #tags', () => {
  const md = linksMarkdown([
    { title: 'Uno', url: 'https://a.com', status: 'unread', tags: ['web dev'], note: '' },
    { title: 'Dos', url: 'https://b.com', status: 'archive', tags: [], note: 'leído' },
  ], 'Lista');
  assert.equal(md, '# Lista\n\n- [ ] [Uno](https://a.com) #web-dev\n- [x] [Dos](https://b.com)\n  > leído\n');
});

// ---- listening ----
test('the voice follows the article language unless one was chosen', () => {
  const voices = [
    { voiceURI: 'en', lang: 'en-US', default: true },
    { voiceURI: 'es-mx', lang: 'es-MX' },
    { voiceURI: 'es-es', lang: 'es-ES', default: true },
  ];
  assert.equal(pickVoice(voices, 'es-ES').voiceURI, 'es-es');
  assert.equal(pickVoice(voices, 'es').voiceURI, 'es-es', 'the default voice of the language');
  assert.equal(pickVoice(voices, 'es-AR').voiceURI, 'es-es');
  assert.equal(pickVoice(voices, 'es', 'es-mx').voiceURI, 'es-mx', 'the one chosen before');
  assert.equal(pickVoice(voices, 'ja'), null);
});
