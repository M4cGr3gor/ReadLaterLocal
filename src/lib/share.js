// "Send by email": saves the article as a single .html file (text, saved pictures, highlights)
// and opens the email program with subject and body filled in; the user attaches the file.
import * as db from './db.js';
import { decompressJson, sanitizeHtml } from './article.js';
import { saveFile, safeFileName, whenDownloaded } from './files.js';
import { displayTitle, hostOf } from './util.js';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

const STYLE = `body{margin:0;background:#fff;color:#1f1e1c;font:18px/1.65 Georgia,"Times New Roman",serif}
main{max-width:680px;margin:0 auto;padding:32px 20px 80px}
.src{font:13px system-ui,sans-serif;color:#6b6a65;word-break:break-all}
h1{font-size:1.7em;line-height:1.2;margin:8px 0 6px}
.meta{font:14px system-ui,sans-serif;color:#6b6a65;padding-bottom:18px;border-bottom:1px solid #ddd;margin-bottom:24px}
img{max-width:100%;height:auto;display:block;margin:1em auto}
pre,code{font:.85em ui-monospace,Consolas,monospace;background:#f3f2ee;border-radius:4px}
pre{padding:12px;overflow-x:auto}
blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #ddd;color:#555}
a{color:#185FA5}
.hl{margin-top:40px;padding-top:16px;border-top:1px solid #ddd;font:15px/1.5 system-ui,sans-serif}
.hl li{margin-bottom:12px}
.hl q{display:block;padding:4px 10px;background:#fff3c4;quotes:none}
.hl .note{font-style:italic;color:#555;margin-top:4px}`;

/**
 * The article as one self-contained HTML page.
 * @returns {Promise<string|null>} null when the item has no saved article
 */
export async function articleHtml(item, labels) {
  const blob = await db.getArticle(item.id);
  if (!blob) return null;
  const art = await decompressJson(blob);
  const doc = new DOMParser().parseFromString(sanitizeHtml(art.html || '', item.url), 'text/html');
  // Saved pictures go inside the file; the rest keep their web address.
  const pictures = item.images ? await db.getImages(item.id) : new Map();
  for (const img of doc.querySelectorAll('img')) {
    img.removeAttribute('loading');
    const saved = pictures.get(img.getAttribute('src'));
    if (saved) {
      const data = await blobToDataUrl(saved);
      if (data) img.setAttribute('src', data);
    }
  }
  const title = art.title || displayTitle(item);
  const highlights = await db.getHighlights(item.id);
  const hl = highlights.length
    ? `<section class="hl"><h2>${esc(labels.highlights)}</h2><ol>${highlights.map(h =>
      `<li><q>${esc(h.text)}</q>${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}</li>`).join('')}</ol></section>`
    : '';
  return `<!doctype html>
<html lang="${esc(art.lang || '')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
<div class="src"><a href="${esc(item.url)}">${esc(item.url)}</a></div>
<h1>${esc(title)}</h1>
<div class="meta">${esc([art.byline, art.siteName || hostOf(item.url)].filter(Boolean).join(' · '))}</div>
<article>${doc.body.innerHTML}</article>
${hl}
</main></body>
</html>
`;
}

/** Opens the email program (mailto:) from an extension page. */
function openMailto(subject, body) {
  const a = document.createElement('a');
  a.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Downloads the article file (if there is one), shows it in its folder so it can be dragged
 * into the email, and opens a new email. Returns the file name saved, or '' for link only.
 */
export async function emailItem(item, labels) {
  const title = displayTitle(item);
  const filename = item.hasArticle ? safeFileName(title, 'html') : '';
  // The email opens first, while the click still counts as the user's action.
  const lines = [title, item.url];
  if (item.note) lines.push('', item.note);
  if (filename) lines.push('', labels.attach.replace('{file}', filename));
  openMailto(title, lines.join('\n'));
  if (!filename) return '';
  const html = await articleHtml(item, labels);
  if (!html) return '';
  const id = await saveFile(new Blob([html], { type: 'text/html' }), filename);
  if (id != null && (await whenDownloaded(id))) browser.downloads.show(id).catch(() => {});
  return filename;
}
