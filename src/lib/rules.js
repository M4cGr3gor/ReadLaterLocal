// Automatic rules: "if the site / url / title matches, add tags, put in a collection, mark favorite".
import { hostOf, normalize, normalizeTags } from './util.js';

/**
 * @typedef {{id?:string, field:'site'|'url'|'title', value:string, tags?:string[], collection?:string, favorite?:boolean}} Rule
 */

export function ruleMatches(rule, rec) {
  const value = normalize(rule.value || '').trim();
  if (!value) return false;
  if (rule.field === 'site') {
    const host = hostOf(rec.url);
    const site = value.replace(/^www\./, '');
    return host === site || host.endsWith('.' + site);
  }
  const target = rule.field === 'title' ? rec.title : rec.url;
  return normalize(target || '').includes(value);
}

/** Returns a copy of rec with every matching rule applied (tags added, never removed). */
export function applyRules(rec, rules = []) {
  const out = { ...rec, tags: [...(rec.tags || [])] };
  for (const rule of rules) {
    if (!ruleMatches(rule, rec)) continue;
    if (rule.tags?.length) out.tags = normalizeTags([...out.tags, ...rule.tags]);
    if (rule.collection && !out.collection) out.collection = rule.collection;
    if (rule.favorite) out.favorite = 1;
  }
  return out;
}

/**
 * Turns what the user typed for "the site is" into a bare host ("https://www.youtube.com/watch"
 * → "youtube.com"). Returns '' when it isn't a valid web address.
 */
export function normalizeSite(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  let host;
  try {
    host = new URL(s).hostname;
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  // Two or more labels and a letters-only ending (or punycode), or localhost.
  const ok = host === 'localhost'
    || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(host);
  return ok ? host : '';
}

/** '' when the value is fine for the field, otherwise the message key explaining the problem. */
export function ruleValueError(field, value) {
  const v = String(value || '').trim();
  if (!v) return field === 'site' ? 'ruleErrSiteEmpty' : 'ruleErrTextEmpty';
  if (field === 'site' && !normalizeSite(v)) return 'ruleErrSite';
  if (field === 'url' && /\s/.test(v)) return 'ruleErrUrlSpaces';
  return '';
}

export async function loadRules() {
  const { rules = [] } = await browser.storage.local.get('rules').catch(() => ({}));
  return rules;
}

export async function saveRules(rules) {
  await browser.storage.local.set({ rules });
}
