// What kind of thing an item is, and how long it takes to read.
import { hostOf } from './util.js';

export const WORDS_PER_MINUTE = 220;
export const SHORT_READ_MINUTES = 5;
export const SHORT_READ_WORDS = WORDS_PER_MINUTE * SHORT_READ_MINUTES;

const VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'twitch.tv', 'dailymotion.com',
  'tiktok.com', 'rumble.com', 'odysee.com', 'bilibili.com', 'vk.com/video', 'ted.com/talks',
];
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;

const onHost = (host, h) => host === h || host.endsWith('.' + h);

export function youtubeId(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  const ok = id => (/^[\w-]{11}$/.test(id || '') ? id : null);
  if (host === 'youtu.be') return ok(u.pathname.slice(1).split('/')[0]);
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
  const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
  return m ? ok(m[1]) : null;
}

export const youtubeThumbUrl = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/** @returns {'article'|'video'|'image'|'other'|'unknown'} */
export function detectKind(item) {
  const host = hostOf(item.url);
  let path = '';
  try { path = new URL(item.url).pathname; } catch { /* keep '' */ }
  const hostPath = host + path;
  if (VIDEO_HOSTS.some(h => (h.includes('/') ? hostPath.startsWith(h) : onHost(host, h)))) return 'video';
  if (IMAGE_EXT.test(path)) return 'image';
  if (item.hasArticle) return 'article';
  if (item.fetchState === 2 || item.fetchState === 3) return 'other';
  return 'unknown';
}

export function readingMinutes(words) {
  return words > 0 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0;
}

export function isShortRead(words) {
  return words > 0 && words <= SHORT_READ_WORDS;
}
