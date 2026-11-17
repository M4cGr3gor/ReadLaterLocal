// Tag suggestions from your own data: tags you already use on the same site, and existing tags
// that appear as words in the title.
import { hostOf, normalize } from './util.js';

const MAX = 6;

/**
 * @param {{url:string, title:string, tags?:string[]}} item
 * @param {{siteTags: Map<string, Map<string, number>>, allTags: string[]}} stats
 */
export function suggestTags(item, stats) {
  const have = new Set(item.tags || []);
  const out = [];
  const add = tag => { if (!have.has(tag) && !out.includes(tag) && out.length < MAX) out.push(tag); };

  const host = hostOf(item.url);
  const bySite = stats.siteTags.get(host);
  if (bySite) [...bySite].sort((a, b) => b[1] - a[1]).forEach(([tag]) => add(tag));

  const words = normalize(item.title || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const found = [];
  for (const tag of stats.allTags) {
    const pos = words.indexOf(normalize(tag));
    if (pos >= 0) found.push([pos, tag]);
  }
  found.sort((a, b) => a[0] - b[0]).forEach(([, tag]) => add(tag));
  return out;
}
