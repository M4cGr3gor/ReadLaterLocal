// Small WebP thumbnails (320×200, ~8-12 KB) from a screenshot data URL or an image Blob.
export const THUMB_W = 320;
export const THUMB_H = 200;

async function loadBitmap(source) {
  if (source instanceof Blob) return createImageBitmap(source);
  const img = new Image();
  img.src = source;
  await img.decode();
  return img;
}

export async function makeThumb(source, { fromTop = true } = {}) {
  const bmp = await loadBitmap(source);
  const w = bmp.naturalWidth || bmp.width;
  const h = bmp.naturalHeight || bmp.height;
  if (!w || !h) return null;
  // Cover-crop to 16:10. Screenshots keep the top of the page (where headlines are).
  const target = THUMB_W / THUMB_H;
  let sw = w;
  let sh = w / target;
  if (sh > h) { sh = h; sw = h * target; }
  const sx = (w - sw) / 2;
  const sy = fromTop ? 0 : (h - sh) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, THUMB_W, THUMB_H);
  bmp.close?.();
  const webp = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.7));
  if (webp?.type === 'image/webp') return webp;
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.7));
}

// Favicons are kept only as small data URLs (one per site).
export async function faviconToDataUrl(url) {
  if (!url) return null;
  if (url.startsWith('data:')) return url.length < 20000 ? url : null;
  try {
    const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > 15000 || !blob.type.startsWith('image/')) return null;
    return await new Promise(resolve => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
