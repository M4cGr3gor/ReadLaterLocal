// Offline pictures: downloads the images of a saved article and keeps them in IndexedDB
// (re-encoded to WebP, at most 1600 px), so the reader can show them without a connection.
// Off by default: a general switch for new saves, plus a per-article switch in the reader.
// Archived items lose their pictures (db.updateItems takes care of that).
import * as db from './db.js';
import { decompressJson } from './article.js';

export const MAX_IMAGES = 60;
const MAX_SOURCE_BYTES = 15_000_000;
const MAX_SIDE = 1600;
const SITE_ACCESS = { origins: ['<all_urls>'] };

export async function offlineImagesEnabled() {
  const { offlineImages = false } = await browser.storage.local.get('offlineImages').catch(() => ({}));
  return offlineImages === true;
}

/** Addresses of the article's pictures, in order, without repeats. */
export function imageUrls(html, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const urls = [...doc.querySelectorAll('img')].map(i => i.getAttribute('src')).filter(u => /^https?:\/\//i.test(u || ''));
  return [...new Set(urls)].slice(0, MAX_IMAGES);
}

const toBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

// Smaller copy for reading on screen. Animated GIFs and SVGs are kept as they are (if small).
async function shrink(blob) {
  if (blob.type === 'image/svg+xml') return blob.size <= 300_000 ? blob : null;
  if (blob.type === 'image/gif') return blob.size <= 2_000_000 ? blob : null;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const webp = await toBlob(canvas, 'image/webp', 0.82);
    if (webp?.type === 'image/webp' && webp.size < blob.size) return webp;
    return blob.size <= 3_000_000 ? blob : webp;
  } catch {
    return blob.size <= 2_000_000 ? blob : null;
  }
}

async function fetchPicture(url, signal) {
  try {
    const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
    if (!res.ok) return null;
    if (Number(res.headers.get('content-length')) > MAX_SOURCE_BYTES) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_SOURCE_BYTES) return null;
    return await shrink(blob);
  } catch {
    return null;
  }
}

/**
 * Downloads and stores the pictures of one article (replacing any stored before).
 * @returns {Promise<{count:number, total:number, bytes:number}|null>} null if cancelled
 */
export async function downloadImages(itemId, { signal = new AbortController().signal, onProgress } = {}) {
  const article = await db.getArticle(itemId);
  if (!article) return { count: 0, total: 0, bytes: 0 };
  const urls = imageUrls((await decompressJson(article)).html || '');
  const pictures = [];
  let done = 0;
  for (const url of urls) {
    if (signal.aborted) return null;
    const blob = await fetchPicture(url, signal);
    if (blob) pictures.push({ url, blob });
    onProgress?.(++done, urls.length);
  }
  if (signal.aborted) return null;
  const item = await db.setImages(itemId, pictures);
  return { count: pictures.length, total: urls.length, bytes: item?.imageBytes ?? 0 };
}

/** After an article is saved: keeps its pictures too when the general switch is on. */
export async function saveImagesIfEnabled(itemId, signal) {
  if (!(await offlineImagesEnabled()) || !(await browser.permissions.contains(SITE_ACCESS))) return null;
  const item = await db.getItem(itemId);
  if (!item || item.status === 'archive' || item.images || item.noImages) return null;
  return downloadImages(itemId, { signal });
}
