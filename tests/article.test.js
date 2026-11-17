import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { sanitizeHtml, compressJson, decompressJson } from '../src/lib/article.js';
import { bookmarksHtml } from '../src/lib/backup.js';

const clean = html => sanitizeHtml(html, 'https://site.com/blog/post', DOMParser);

test('sanitizeHtml drops scripts, styles, iframes, forms and event handlers', () => {
  const out = clean('<p onclick="x()">Hola<script>alert(1)</script></p><style>p{}</style><iframe src="https://e.com"></iframe><form><input></form><img src="x.png" onerror="alert(1)">');
  assert.ok(!/script|style|iframe|form|input|onclick|onerror|alert/i.test(out), out);
  assert.ok(out.includes('<p>Hola</p>'), out);
});

test('sanitizeHtml makes links and images absolute and blocks javascript: urls', () => {
  const out = clean('<a href="/otro">a</a><a href="javascript:alert(1)">b</a><img src="img/a.png" alt="A" srcset="big.png 2x">');
  assert.ok(out.includes('href="https://site.com/otro"'), out);
  assert.ok(!out.includes('javascript'), out);
  assert.ok(out.includes('src="https://site.com/blog/img/a.png"'), out);
  assert.ok(!out.includes('srcset'), out);
  assert.ok(out.includes('target="_blank"') && out.includes('rel="noopener noreferrer"'), out);
});

test('sanitizeHtml unwraps unknown elements but keeps their text', () => {
  const out = clean('<custom-el><b>negrita</b> texto</custom-el><font color="red">rojo</font>');
  assert.equal(out, '<b>negrita</b> textorojo');
});

test('sanitizeHtml keeps tables, lists, code and drops style/class attributes', () => {
  const out = clean('<table class="x"><tr><td colspan="2" style="color:red">1</td></tr></table><ul><li>a</li></ul><pre><code>x &lt; y</code></pre>');
  assert.ok(out.includes('<td colspan="2">1</td>'), out);
  assert.ok(!out.includes('class=') && !out.includes('style='), out);
  assert.ok(out.includes('<ul><li>a</li></ul>'), out);
  assert.ok(out.includes('<pre><code>x &lt; y</code></pre>'), out);
});

test('compressJson / decompressJson round-trip and actually shrink text', async () => {
  const obj = { title: 'T', html: '<p>' + 'lorem ipsum dolor sit amet '.repeat(400) + '</p>' };
  const blob = await compressJson(obj);
  assert.ok(blob.size < JSON.stringify(obj).length / 5, `compressed ${blob.size}`);
  assert.deepEqual(await decompressJson(blob), obj);
});

test('bookmarksHtml produces an importable Netscape bookmarks file', () => {
  const html = bookmarksHtml([
    { title: 'A <b> & "c"', url: 'https://a.com/?x=1&y=2', time_added: 1700000000, tags: ['css', 'web'], status: 'unread', favorite: 0 },
  ]);
  assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
  assert.ok(html.includes('<DT><A HREF="https://a.com/?x=1&amp;y=2" ADD_DATE="1700000000" TAGS="css,web">A &lt;b&gt; &amp; &quot;c&quot;</A>'), html);
});
