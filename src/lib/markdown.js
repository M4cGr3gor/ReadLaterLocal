// Markdown: a link to copy, the whole article (for Obsidian and other notes apps) and the
// list of saved links. Loaded only when one of these is used.
import { displayTitle, hostOf } from './util.js';

const escapeText = s => s.replace(/([\\`*_[\]])/g, '\\$1');
const escapeLinkText = s => s.replace(/([\\[\]])/g, '\\$1');
// Brackets and spaces would end the link early (encodeURIComponent leaves brackets alone).
const URL_CHARS = { '(': '%28', ')': '%29' };
const linkUrl = url => String(url || '').replace(/[()\s]/g, c => URL_CHARS[c] || encodeURIComponent(c));
const isoDate = seconds => new Date(seconds * 1000).toISOString().slice(0, 10);

/** [Title](url) */
export function linkMarkdown(item) {
  return `[${escapeLinkText(displayTitle(item))}](${linkUrl(item.url)})`;
}

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul']);

function inline(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += escapeText(child.nodeValue.replace(/\s+/g, ' ')); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.localName;
    const inner = () => inline(child).trim();
    if (tag === 'br') out += '  \n';
    else if (tag === 'strong' || tag === 'b') out += wrap(inner(), '**');
    else if (tag === 'em' || tag === 'i') out += wrap(inner(), '*');
    else if (tag === 'del' || tag === 's') out += wrap(inner(), '~~');
    else if (tag === 'code') out += codeSpan(child.textContent);
    else if (tag === 'a') {
      const href = child.getAttribute('href');
      const text = inner();
      out += href && /^https?:|^mailto:/i.test(href) ? `[${text || href}](${linkUrl(href)})` : text;
    } else if (tag === 'img') {
      const src = child.getAttribute('data-src') || child.getAttribute('src');
      if (src && /^https?:/i.test(src)) out += `![${escapeLinkText(child.getAttribute('alt') || '')}](${linkUrl(src)})`;
    } else if (BLOCK.has(tag)) out += ' ' + blocks(child).join(' ') + ' ';
    else out += inline(child);
  }
  return out;
}

const wrap = (text, mark) => (text ? `${mark}${text}${mark}` : '');
function codeSpan(text) {
  const ticks = '`'.repeat(Math.max(1, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${ticks}${text}${ticks}`;
}

// Blank lines get no trailing spaces (just ">" inside a quote).
const prefixLines = (text, first, rest = ' '.repeat(first.length)) =>
  text.split('\n').map((line, i) => (line ? (i ? rest : first) + line : (i ? rest : first).trimEnd())).join('\n');

function list(node, ordered) {
  const items = [];
  let n = Number(node.getAttribute('start')) || 1;
  for (const li of node.children) {
    if (li.localName !== 'li') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    items.push(prefixLines(blocks(li).join('\n\n') || '', marker));
  }
  return items.join('\n');
}

function table(node) {
  const rows = [...node.querySelectorAll('tr')].map(tr =>
    [...tr.children].map(cell => inline(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map(r => r.length));
  const line = r => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

// The block-level pieces of a node, as Markdown paragraphs.
function blocks(node) {
  const out = [];
  let pending = '';
  const flush = () => { const t = pending.trim(); if (t) out.push(t); pending = ''; };
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { pending += escapeText(child.nodeValue.replace(/\s+/g, ' ')); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.localName;
    if (!BLOCK.has(tag)) { pending += inline({ childNodes: [child] }); continue; }
    flush();
    if (/^h[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${inline(child).trim()}`);
    else if (tag === 'p') { const t = inline(child).trim(); if (t) out.push(t); }
    else if (tag === 'pre') out.push('```\n' + child.textContent.replace(/\n$/, '') + '\n```');
    else if (tag === 'blockquote') out.push(prefixLines(blocks(child).join('\n\n'), '> ', '> '));
    else if (tag === 'ul' || tag === 'ol') out.push(list(child, tag === 'ol'));
    else if (tag === 'hr') out.push('---');
    else if (tag === 'table') out.push(table(child));
    else if (tag === 'figcaption') { const t = inline(child).trim(); if (t) out.push(`*${t}*`); }
    else out.push(...blocks(child));
  }
  flush();
  return out.filter(Boolean);
}

/** Article HTML (already sanitised) to Markdown. */
export function htmlToMarkdown(html, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  return blocks(doc.body).join('\n\n');
}

const yaml = s => JSON.stringify(String(s ?? ''));

/**
 * The whole article as a Markdown note: a header with its details (title, address, date, tags,
 * note), the text, and the highlights with their notes at the end.
 * @param {object} item
 * @param {{title?:string, byline?:string, siteName?:string, html?:string}} art
 * @param {{text:string, note?:string}[]} highlights
 * @param {{highlights:string}} labels
 */
export function articleMarkdown(item, art, highlights, labels, DOMParserImpl = globalThis.DOMParser) {
  const title = art.title || displayTitle(item);
  const head = ['---', `title: ${yaml(title)}`, `url: ${yaml(item.url)}`, `saved: ${isoDate(item.time_added)}`];
  if (art.byline) head.push(`author: ${yaml(art.byline)}`);
  if (item.tags?.length) head.push(`tags: [${item.tags.map(yaml).join(', ')}]`);
  if (item.note) head.push(`note: ${yaml(item.note)}`);
  head.push('---');
  const parts = [head.join('\n'), `# ${title}`, `${art.siteName || hostOf(item.url)} · <${item.url}>`];
  if (art.html) parts.push(htmlToMarkdown(art.html, DOMParserImpl));
  if (highlights.length) {
    parts.push(`## ${labels.highlights}`);
    for (const h of highlights) parts.push(prefixLines(h.text.trim(), '> ', '> ') + (h.note ? `\n\n${h.note.trim()}` : ''));
  }
  return parts.join('\n\n') + '\n';
}

/** Every saved link as a Markdown list, with tags (as #tags) and notes. */
export function linksMarkdown(items, heading) {
  const lines = [`# ${heading}`, ''];
  for (const item of items) {
    const tags = (item.tags || []).map(tag => `#${tag.replace(/\s+/g, '-')}`).join(' ');
    let line = `- ${item.status === 'archive' ? '[x]' : '[ ]'} ${linkMarkdown(item)}`;
    if (tags) line += ` ${tags}`;
    lines.push(line);
    if (item.note) lines.push(prefixLines(item.note.trim(), '  > ', '  > '));
  }
  return lines.join('\n') + '\n';
}
