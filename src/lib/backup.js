// Export formats besides CSV: Netscape bookmarks HTML and the full .json.gz backup.
import { compressJson, decompressJson } from './article.js';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function bookmarksHtml(items) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Read Later Local</TITLE>',
    '<H1>Read Later Local</H1>',
    '<DL><p>',
  ];
  for (const i of items) {
    const tags = (i.tags || []).join(',');
    lines.push(`<DT><A HREF="${esc(i.url)}" ADD_DATE="${i.time_added}"${tags ? ` TAGS="${esc(tags)}"` : ''}>${esc(i.title || i.url)}</A>`);
  }
  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}

export const fullBackupToBlob = data => compressJson(data);

// Accepts .json.gz (our backups) and plain .json.
export async function readFullBackup(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const data = head[0] === 0x1f && head[1] === 0x8b ? await decompressJson(file) : JSON.parse(await file.text());
  if (data?.format !== 'read-later-local' || !Array.isArray(data.items)) throw new Error('Not a Read Later Local backup');
  return data;
}

export function dateStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
