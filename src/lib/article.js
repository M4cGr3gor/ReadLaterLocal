// Saved articles: sanitising Readability's HTML and storing it gzip-compressed.

export const MAX_ARTICLE_HTML = 1_000_000;

// Elements kept as-is. Anything else is unwrapped (its text survives) unless it's in DROP.
const ALLOWED = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark', 'abbr', 'cite', 'q', 'time',
  'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'dl', 'dt', 'dd', 'div', 'span', 'section', 'article', 'kbd', 'var', 'samp', 'del', 'ins',
]);
// Elements removed together with everything inside them.
const DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea',
  'svg', 'math', 'noscript', 'template', 'link', 'meta', 'base', 'frame', 'frameset', 'audio',
  'video', 'canvas', 'source', 'track', 'dialog', 'head', 'title',
]);
const ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  ol: ['start'],
  time: ['datetime'],
  abbr: ['title'],
};

function safeUrl(value, base, schemes) {
  try {
    const u = new URL(value, base);
    return schemes.includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Rebuilds `html` from an allow-list into fresh nodes, so nothing executable survives.
 * Relative links and images become absolute against `baseUrl`.
 */
export function sanitizeHtml(html, baseUrl, DOMParserImpl = globalThis.DOMParser) {
  const parser = new DOMParserImpl();
  const src = parser.parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const out = parser.parseFromString('<!doctype html><html><body></body></html>', 'text/html');
  const root = out.body;

  const copy = (node, parent) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) { parent.append(out.createTextNode(child.nodeValue)); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.localName.toLowerCase();
      if (DROP.has(tag)) continue;
      if (!ALLOWED.has(tag)) { copy(child, parent); continue; }
      const el = out.createElement(tag);
      for (const name of ATTRS[tag] || []) {
        const value = child.getAttribute(name);
        if (value == null) continue;
        if (name === 'href') {
          const u = safeUrl(value, baseUrl, ['http:', 'https:', 'mailto:']);
          if (u) el.setAttribute('href', u);
        } else if (name === 'src') {
          const u = safeUrl(value, baseUrl, ['http:', 'https:']);
          if (u) el.setAttribute('src', u);
        } else {
          el.setAttribute(name, value.slice(0, 500));
        }
      }
      if (tag === 'img' && !el.hasAttribute('src')) continue;
      if (tag === 'a' && el.hasAttribute('href')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag === 'img') el.setAttribute('loading', 'lazy');
      copy(child, el);
      parent.append(el);
    }
  };
  copy(src.body, root);
  return root.innerHTML;
}

async function streamThrough(blob, transform) {
  return new Response(blob.stream().pipeThrough(transform)).blob();
}

export async function compressJson(obj) {
  return streamThrough(new Blob([JSON.stringify(obj)]), new CompressionStream('gzip'));
}

export async function decompressJson(blob) {
  const plain = await streamThrough(blob, new DecompressionStream('gzip'));
  return JSON.parse(await plain.text());
}

/**
 * Turns a Readability result into what we store: { blob, words, text }, or null when there is no real article.
 * @param {{title?:string, byline?:string, siteName?:string, content?:string, textContent?:string, excerpt?:string, lang?:string}} parsed
 */
export async function packArticle(parsed, url, DOMParserImpl = globalThis.DOMParser) {
  if (!parsed?.content || (parsed.textContent || '').trim().length < 200) return null;
  if (parsed.content.length > MAX_ARTICLE_HTML) return null;
  const html = sanitizeHtml(parsed.content, url, DOMParserImpl);
  const words = (parsed.textContent || '').trim().split(/\s+/).length;
  const blob = await compressJson({
    v: 1,
    title: parsed.title || '',
    byline: parsed.byline || '',
    siteName: parsed.siteName || '',
    lang: parsed.lang || '',
    words,
    html,
  });
  return { blob, words, text: parsed.textContent || '' };
}
