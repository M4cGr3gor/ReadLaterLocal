// The same page reached through different addresses: tracking parameters, "www." or "m.",
// a trailing slash, an anchor, http/https, or YouTube's several links to one video.
import { youtubeId } from './classify.js';

// Parameters added by newsletters, ads and social networks; they never change the page.
const TRACKING = /^(utm_|mc_|_hs|hsa_|pk_|mtm_|matomo_|oly_|vero_|__s)|^(fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|igsh|twclid|ttclid|li_fat_id|mkt_tok|ref_src|ref_url|s_cid|_ga|_gl|cmpid|campaign_id|ncid)$/i;
// "si" only means "share id" on these sites; elsewhere it may be part of the address.
const SHARE_ID_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/i;

function parse(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

/** The address without tracking parameters (anything else is kept as it was). */
export function cleanUrl(url) {
  const u = parse(url);
  if (!u || !u.search) return url;
  const shareId = SHARE_ID_HOSTS.test(u.hostname);
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.test(key) || (shareId && key === 'si')) { u.searchParams.delete(key); changed = true; }
  }
  if (!changed) return url;
  return u.href.replace(/\?(?=#|$)/, '');
}

/**
 * What two addresses of the same page have in common, to spot duplicates.
 * Ignores http/https, "www."/"m.", tracking parameters, the order of parameters,
 * a trailing slash and the anchor (except "#!" and "#/" routes of web apps).
 */
export function urlKey(url) {
  const yt = youtubeId(url);
  if (yt) return `youtube:${yt}`;
  const u = parse(cleanUrl(url));
  if (!u) return String(url ?? '');
  const host = u.hostname.toLowerCase().replace(/^(www\d?|m|mobile)\./, '');
  const port = u.port ? `:${u.port}` : '';
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const params = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  const hash = /^#[!/]/.test(u.hash) ? u.hash : '';
  return `${host}${port}${path}${query}${hash}`;
}
