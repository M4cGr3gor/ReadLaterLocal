// Downloads article text, real title, preview image and site icon for items that were
// imported (they have no open tab). Needs the optional "<all_urls>" permission.
// Uses Mozilla's Readability (src/vendor/Readability.js), loaded only the first time it's needed.
import * as db from './db.js';
import { packArticle } from './article.js';
import { makeThumb, faviconToDataUrl } from './thumbs.js';
import { hostOf } from './util.js';
import { detectKind, youtubeId, youtubeThumbUrl } from './classify.js';
import { saveImagesIfEnabled } from './images.js';

const MAX_PAGE_BYTES = 3_000_000;

// Readability is 90 KB of code: pages load it when they first download an article, not on opening.
let readabilityLoad = null;
function loadReadability() {
  if (globalThis.Readability) return Promise.resolve();
  readabilityLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/Readability.js', import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => { readabilityLoad = null; reject(new Error('Readability could not be loaded')); };
    document.head.append(script);
  });
  return readabilityLoad;
}
export const ALL_URLS = { origins: ['<all_urls>'] };

export const hasSitePermission = () => browser.permissions.contains(ALL_URLS);

/**
 * Decodes a page with the character set it declares (HTTP header, then <meta>), because
 * Response.text() always assumes UTF-8 and many Spanish sites still use ISO-8859-1.
 */
export function decodeHtml(buffer, contentType = '') {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta]) {
    if (!label) continue;
    try {
      return new TextDecoder(label.toLowerCase()).decode(bytes);
    } catch { /* unknown label: try the next one */ }
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  // No declaration and broken as UTF-8: it's almost certainly Windows-1252.
  return (utf8.match(/\uFFFD/g) || []).length > 3 ? new TextDecoder('windows-1252').decode(bytes) : utf8;
}

function meta(doc, ...names) {
  for (const n of names) {
    const v = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content');
    if (v?.trim()) return v.trim();
  }
  return null;
}

async function fetchThumb(imageUrl, signal) {
  try {
    const res = await fetch(imageUrl, { credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > 8_000_000) return null;
    return await makeThumb(blob, { fromTop: false });
  } catch {
    return null;
  }
}

async function saveThumbIfMissing(item, imageUrl, signal) {
  if (!imageUrl || (await db.getThumb(item.id))) return;
  const thumb = await fetchThumb(imageUrl, signal);
  if (thumb) await db.setThumb(item.id, thumb);
}

// YouTube: no need to download the (huge) page. The thumbnail has a fixed address and the
// title comes from YouTube's small oEmbed endpoint.
async function fetchYouTube(item, id, signal) {
  await saveThumbIfMissing(item, youtubeThumbUrl(id), signal);
  const patch = { fetchState: 3 };
  if (item.title === item.url) {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(item.url)}`,
        { credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (res.ok) patch.title = String((await res.json()).title || '').slice(0, 300) || item.title;
    } catch { /* keep the url as title */ }
  }
  await db.updateItem(item.id, patch);
  return 'partial';
}

/** Processes one item. Returns 'ok' (article saved), 'partial' (only title/image) or 'failed'. */
export async function fetchItem(item, signal) {
  const ytId = youtubeId(item.url);
  if (ytId) return fetchYouTube(item, ytId, signal);
  if (detectKind(item) === 'image') {
    await saveThumbIfMissing(item, item.url, signal);
    await db.updateItem(item.id, { fetchState: 3 });
    return 'partial';
  }

  let res;
  try {
    res = await fetch(item.url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  } catch {
    if (signal.aborted) throw signal.reason;
    await db.updateItem(item.id, { fetchState: 2 });
    return 'failed';
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('html')) {
    await db.updateItem(item.id, { fetchState: 2 });
    return 'failed';
  }
  const html = decodeHtml(await res.arrayBuffer(), type).slice(0, MAX_PAGE_BYTES);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = doc.createElement('base');
  base.href = res.url;
  doc.head.prepend(base);

  // Real title for items that only had their url (Pocket did that a lot).
  const patch = {};
  const title = meta(doc, 'og:title', 'twitter:title') || doc.title?.trim();
  if (title && (item.title === item.url || item.title.includes("\uFFFD"))) patch.title = title.slice(0, 300);

  const img = meta(doc, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  await saveThumbIfMissing(item, img && URL.canParse(img, res.url) ? new URL(img, res.url).href : null, signal);

  const host = hostOf(item.url);
  if (host && !(await db.getFavicon(host))) {
    const link = doc.querySelector('link[rel~="icon"]')?.getAttribute('href');
    const icon = await faviconToDataUrl(new URL(link || '/favicon.ico', res.url).href);
    if (icon) await db.setFavicon(host, icon);
  }

  let packed = null;
  try {
    await loadReadability();
    packed = await packArticle(new Readability(doc, { charThreshold: 300 }).parse(), res.url);
  } catch {
    packed = null;
  }
  if (packed) {
    await db.setArticle(item.id, packed.blob, packed.words, packed.text);
    await saveImagesIfEnabled(item.id, signal).catch(() => {});
    if (Object.keys(patch).length) await db.updateItem(item.id, patch);
    return 'ok';
  }
  await db.updateItem(item.id, { ...patch, fetchState: 2 });
  return 'partial';
}

/**
 * Runs through the queue with a few requests in parallel.
 * onProgress({done, total, ok, partial, failed})
 */
export async function fetchAll(items, { signal, onProgress, concurrency = 3, pauseMs = 0 }) {
  const stats = { done: 0, total: items.length, ok: 0, partial: 0, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) {
      const item = items[next++];
      try {
        stats[await fetchItem(item, signal)]++;
      } catch {
        if (signal.aborted) return;
        stats.failed++;
      }
      stats.done++;
      onProgress?.({ ...stats, id: item.id });
      if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}
