// Demo data for the store screenshots (dev only, never packaged): invented articles from
// invented sites, illustrations drawn here, collections, tags, rules and highlights.
import * as db from '/src/lib/db.js';
import { packArticle } from '/src/lib/article.js';
import { makeThumb } from '/src/lib/thumbs.js';

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

// ---- illustrations (drawn on a canvas, then made into thumbnails like the extension does) ----
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const STYLES = {
  mountains(g, w, h, [a, b, c, d], r) {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, a); sky.addColorStop(1, b);
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff7'; g.beginPath(); g.arc(w * 0.72, h * 0.3, 46, 0, 7); g.fill();
    for (const [color, base, amp] of [[c, 0.62, 0.22], [d, 0.78, 0.16]]) {
      g.fillStyle = color; g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 40) g.lineTo(x, h * base - r() * h * amp);
      g.lineTo(w, h); g.fill();
    }
  },
  bokeh(g, w, h, [a, b, c, d], r) {
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, a); bg.addColorStop(1, b);
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      g.fillStyle = (i % 2 ? c : d) + '55';
      g.beginPath(); g.arc(r() * w, r() * h, 12 + r() * 60, 0, 7); g.fill();
    }
  },
  waves(g, w, h, [a, b, c, d]) {
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    [b, c, d].forEach((color, i) => {
      g.fillStyle = color; g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) g.lineTo(x, h * (0.45 + i * 0.16) + Math.sin(x / 70 + i * 2) * 22);
      g.lineTo(w, h); g.fill();
    });
  },
  blocks(g, w, h, [a, b, c, d], r) {
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    for (let y = 30; y < h - 30; y += 46) {
      let x = 40;
      while (x < w - 60) {
        const bw = 40 + r() * 140;
        g.fillStyle = [b, c, d][Math.floor(r() * 3)];
        g.beginPath(); g.roundRect(x, y, Math.min(bw, w - 40 - x), 26, 6); g.fill();
        x += bw + 14;
      }
    }
  },
  pages(g, w, h, [a, b, c, d]) {
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5; i++) {
      g.save(); g.translate(w / 2, h / 2 + 20); g.rotate((i - 2) * 0.09);
      g.fillStyle = i % 2 ? b : '#fffdf8'; g.shadowColor = '#0003'; g.shadowBlur = 12;
      g.fillRect(-120, -150, 240, 300); g.restore();
    }
    g.fillStyle = c;
    for (let i = 0; i < 9; i++) g.fillRect(w / 2 - 90, h / 2 - 100 + i * 24, i % 3 === 2 ? 110 : 180, 7);
    g.fillStyle = d; g.fillRect(w / 2 - 90, h / 2 - 130, 120, 14);
  },
  leaves(g, w, h, [a, b, c, d], r) {
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 18; i++) {
      g.save(); g.translate(r() * w, r() * h); g.rotate(r() * 6.28);
      g.fillStyle = [b, c, d][i % 3]; g.beginPath(); g.ellipse(0, 0, 70, 26, 0, 0, 7); g.fill();
      g.strokeStyle = '#ffffff55'; g.lineWidth = 2; g.beginPath(); g.moveTo(-60, 0); g.lineTo(60, 0); g.stroke();
      g.restore();
    }
  },
  stars(g, w, h, [a, b, c], r) {
    const sky = g.createRadialGradient(w * 0.6, h * 0.4, 20, w / 2, h / 2, w);
    sky.addColorStop(0, b); sky.addColorStop(1, a);
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    for (let i = 0; i < 160; i++) { const s = r() * 2.2; g.fillRect(r() * w, r() * h, s, s); }
    g.fillStyle = c; g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 30) g.lineTo(x, h * 0.86 - r() * 24);
    g.lineTo(w, h); g.fill();
  },
};

async function illustration(style, palette, seed) {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 400;
  STYLES[style](c.getContext('2d'), 640, 400, palette, rng(seed));
  return makeThumb(c.toDataURL('image/png'), { fromTop: false });
}

// ---- the article shown in the reader ----
const ARTICLE = `
<p>Most of us read more words every day than any generation before us, and remember fewer of them. We skim headlines, scroll past threads and open twenty tabs we promise to come back to. The problem isn't a lack of good writing. It's that we rarely give it the time it asks for.</p>
<h2>Why slow reading matters</h2>
<p>Reading slowly is not about reading less. It is about letting an idea finish arriving before the next one pushes it out. When you stay with a long article from beginning to end, you start to notice how the argument is built, where the writer hesitates and which sentence everything else depends on.</p>
<blockquote><p>A good article is a conversation. Skimming is nodding along while thinking about something else.</p></blockquote>
<p>There is also a practical benefit: what you read carefully, you can use. A single essay read with attention will change your thinking more than a dozen read in a hurry.</p>
<h2>Building the habit</h2>
<p>You don't need a cabin in the woods. A few small changes go a long way:</p>
<ul>
<li><strong>Save instead of opening.</strong> When something looks worth reading, save it for later and close the tab.</li>
<li><strong>Pick a time.</strong> Twenty minutes with a coffee in the morning beats an hour you never find.</li>
<li><strong>Read offline.</strong> No notifications, no related links, no comment section waiting at the bottom.</li>
<li><strong>Write one line.</strong> A short note about why it mattered is how an article turns into something you keep.</li>
</ul>
<h2>Letting go of the backlog</h2>
<p>Every reading list grows faster than it shrinks. That is fine. A list is a menu, not a debt. Once a month, go through what you saved: keep what still sparks curiosity, archive what you have read, and delete what no longer matters. The goal is not an empty list, but a list you are happy to open.</p>
<p>The articles worth your time will still be there tomorrow. The trick is to make sure that, when you finally sit down to read, you actually read.</p>`;

const HIGHLIGHTS = [
  { text: 'It is about letting an idea finish arriving before the next one pushes it out.', color: 'yellow', note: 'The best definition of "slow reading" I have found.' },
  { text: 'A single essay read with attention will change your thinking more than a dozen read in a hurry.', color: 'green', note: '' },
  { text: 'A list is a menu, not a debt.', color: 'pink', note: 'Remember this when the list gets long!' },
];

// ---- items ----
const P = {
  dusk: ['#FDE2C4', '#F6A97A', '#B5566B', '#5B3A6B'],
  forest: ['#E3F1E6', '#9CCB9E', '#4E8B63', '#24533C'],
  sea: ['#DCEFF6', '#7BB8D4', '#3C7FA6', '#1E4E70'],
  code: ['#1E2433', '#4F8CFF', '#7CE0C3', '#F7B955'],
  paper: ['#EFE6DA', '#E2D3BF', '#8C7A66', '#C45B3C'],
  night: ['#0B1430', '#2B3F7A', '#11182E'],
  bloom: ['#FFF1F0', '#F7A8B8', '#B9A3E3', '#8FD3C1'],
  sand: ['#F7EFDF', '#E7C98E', '#D08C4F', '#8A5A3B'],
};

const ITEMS = [
  { title: 'The Art of Reading Slowly', url: 'https://slowpages.blog/the-art-of-reading-slowly', tags: ['reading', 'habits'], col: 'Long reads', fav: 1, words: 1100, art: true, pic: ['pages', P.paper], age: 0.2, note: 'Read this one on Sunday morning.' },
  { title: 'CSS Grid Explained in Five Minutes', url: 'https://devnotes.io/css-grid-in-five-minutes', tags: ['web'], col: 'Dev', fav: 1, words: 900, pic: ['blocks', P.code], age: 0.6 },
  { title: 'Ten Quiet Trails for an Autumn Weekend', url: 'https://trailnotes.org/quiet-autumn-trails', tags: ['travel', 'nature'], words: 1300, pic: ['mountains', P.dusk], age: 1.1 },
  { title: "A Beginner's Guide to Sourdough Starters", url: 'https://ferment.kitchen/sourdough-starter-guide', tags: ['cooking'], col: 'Recipes', words: 1800, pic: ['bokeh', P.sand], age: 1.5 },
  { title: 'Why Small Habits Beat Big Goals', url: 'https://mindwork.blog/small-habits-big-goals', tags: ['habits'], words: 1500, pic: ['waves', P.bloom], age: 2.2, note: 'Share with the team.' },
  { title: 'Photographing the Milky Way with Your Phone', url: 'https://skyatnight.blog/milky-way-phone', tags: ['photography'], fav: 1, words: 1200, pic: ['stars', P.night], age: 2.9 },
  { title: 'Understanding JavaScript Promises Once and for All', url: 'https://devnotes.io/javascript-promises', tags: ['web'], col: 'Dev', words: 2600, pic: ['blocks', ['#20253A', '#C792EA', '#82AAFF', '#FFCB6B']], age: 3.4 },
  { title: 'How Night Trains Are Making a Comeback', url: 'https://slowtravel.eu/night-trains-comeback', tags: ['travel'], col: 'Long reads', words: 2100, pic: ['mountains', ['#1C2541', '#3A506B', '#5BC0BE', '#0B132B']], age: 4.1 },
  { title: "The Science of a Good Night's Sleep", url: 'https://wellbeing.daily/science-of-sleep', tags: ['health'], words: 1700, expires: 14, pic: ['waves', P.sea], age: 4.8 },
  { title: 'Weekly Brief: Climate, Space and Technology', url: 'https://dailybrief.news/weekly-45', tags: ['news'], col: 'News', words: 800, pic: ['bokeh', ['#E8EEF7', '#9DB4D9', '#4C6EA8', '#F2B880']], age: 5.5 },
  { title: 'A Field Guide to Urban Birds', url: 'https://birdwatch.org/urban-birds-field-guide', tags: ['nature'], words: 1400, pic: ['leaves', P.forest], age: 6.3 },
  { title: 'Building a Home Server with a Raspberry Pi', url: 'https://homelab.dev/raspberry-pi-home-server', tags: ['homelab'], col: 'Dev', words: 3200, pic: ['blocks', ['#0F1F17', '#3DDC97', '#256D85', '#E9F5DB']], age: 7.1 },
  { title: 'Minimalist Desk Setups That Actually Work', url: 'https://workspace.blog/minimalist-desk-setups', tags: ['habits'], words: 700, pic: ['pages', ['#F3F1EC', '#DCD6CC', '#6F6A61', '#3D8A7A']], age: 8.4 },
  { title: 'Learning Spanish: 30 Phrases for Your First Trip', url: 'https://languagelab.io/spanish-first-trip', tags: ['travel'], words: 1000, pic: ['bokeh', ['#FFF4E0', '#FFB347', '#E4572E', '#29335C']], age: 9.2 },
  { title: 'What Makes a Great Podcast Interview', url: 'https://audiocraft.fm/great-podcast-interviews', tags: ['audio'], fav: 1, words: 1600, pic: ['waves', ['#F4F0FF', '#B8A4F4', '#7A5CC7', '#3E2A84']], age: 10.5 },
  { title: 'Deep Dive: How Databases Keep Your Data Safe', url: 'https://devnotes.io/databases-durability', tags: ['web', 'homelab'], col: 'Dev', words: 4200, pic: ['blocks', P.code], age: 12 },
  { title: 'Weekly Brief: Elections, Markets and Sport', url: 'https://dailybrief.news/weekly-44', tags: ['news'], col: 'News', words: 750, pic: ['bokeh', ['#EEF2F6', '#A7B8CC', '#55708F', '#E07A5F']], age: 12.6 },
  { title: 'The Short History of the Paperback', url: 'https://bookhistory.org/paperback', tags: ['reading'], words: 2300, status: 'archive', pic: ['pages', P.sand], age: 15 },
  { title: 'Notes on Personal Knowledge Management', url: 'https://mindwork.blog/pkm-notes', tags: ['habits'], words: 1900, status: 'archive', fav: 1, pic: ['leaves', P.bloom], age: 18 },
  { title: 'Spring Deals on Hiking Gear', url: 'https://outdoorgear.shop/spring-deals', tags: ['deals'], words: 400, pic: ['mountains', P.forest], age: 3 },
];

export async function seedDemo() {
  await db.clearAll();
  await browser.storage.local.set({
    theme: 'light', view: 'grid', thumbSize: 'm', listOrder: 'newest', listFacet: 'tags',
    badge: true, bgFetch: false, offlineImages: false, textsCompact: 1,
    collections: [
      { id: 'cdev', name: 'Dev' }, { id: 'clong', name: 'Long reads' }, { id: 'cnews', name: 'News' }, { id: 'crec', name: 'Recipes' },
    ],
    rules: [
      { id: 'r1', field: 'site', value: 'devnotes.io', tags: ['web'], collection: 'cdev', favorite: false },
      { id: 'r2', field: 'site', value: 'ferment.kitchen', tags: ['cooking'], collection: 'crec', favorite: false },
      { id: 'r3', field: 'title', value: 'podcast', tags: ['audio'], collection: '', favorite: true },
    ],
    cleanup: [
      { id: 'k1', active: true, scope: 'collection', value: 'cnews', status: 'any', amount: 1, unit: 'month' },
      { id: 'k2', active: true, scope: 'tag', value: 'deals', status: 'any', amount: 1, unit: 'week' },
      { id: 'k3', active: true, scope: 'all', value: '', status: 'archive', amount: 1, unit: 'year' },
      { id: 'k4', active: false, scope: 'site', value: 'dailybrief.news', status: 'unread', amount: 3, unit: 'month' },
    ],
    backup: { enabled: true, frequency: 'weekly', keep: 3, lastRun: Date.now() - 2 * DAY * 1000, files: [] },
  });
  const colId = { Dev: 'cdev', 'Long reads': 'clong', News: 'cnews', Recipes: 'crec' };
  await db.importRecords(ITEMS.map(i => ({
    title: i.title, url: i.url, tags: i.tags, status: i.status || 'unread', favorite: i.fav || 0,
    collection: colId[i.col] || '', note: i.note || '', time_added: now - Math.round(i.age * DAY),
    expires: i.expires ? now + i.expires * DAY : 0,
  })));
  const byUrl = new Map((await db.allItems()).map(i => [i.url, i]));
  let seed = 7;
  for (const i of ITEMS) {
    const item = byUrl.get(i.url);
    await db.setThumb(item.id, await illustration(i.pic[0], i.pic[1], seed += 13));
    if (!i.art) {
      await db.updateItem(item.id, { words: i.words, fetchState: 1 });
      continue;
    }
    const doc = new DOMParser().parseFromString(ARTICLE, 'text/html');
    const packed = await packArticle({ title: i.title, byline: 'Mara Lindqvist', siteName: 'Slow Pages', content: ARTICLE, textContent: doc.body.textContent, lang: 'en' }, i.url);
    await db.setArticle(item.id, packed.blob, packed.words, packed.text);
    // Highlights are kept as offsets in the article's text, as the reader stores them.
    const rendered = new DOMParser().parseFromString(packed && (await (await import('/src/lib/article.js')).decompressJson(packed.blob)).html, 'text/html').body.textContent;
    for (const h of HIGHLIGHTS) {
      const start = rendered.indexOf(h.text);
      if (start >= 0) await db.saveHighlight({ itemId: item.id, start, end: start + h.text.length, text: h.text, note: h.note, color: h.color });
    }
  }
  // A couple of items in the trash, as automatic cleanup would leave them.
  const old = await db.addItems([
    { title: 'Weekly Brief: Elections and Weather', url: 'https://dailybrief.news/weekly-38', time_added: now - 40 * DAY, tags: [], status: 'unread' },
    { title: 'Summer Sale on Camping Tents', url: 'https://outdoorgear.shop/summer-sale', time_added: now - 60 * DAY, tags: [], status: 'unread' },
  ]);
  await db.moveToTrash(old.added.map(i => i.id), 'rule');
  return ITEMS.length;
}
