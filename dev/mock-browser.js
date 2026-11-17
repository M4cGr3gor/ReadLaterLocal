// Minimal fake of the WebExtension `browser` API so the popup and list pages can be
// previewed in a normal browser tab (dev only; never packaged — it lives outside src/).
const params = new URLSearchParams(location.search);
const lang = params.get('lang') || 'es';
const messages = await (await fetch(`/src/_locales/${lang}/messages.json`)).json();
const store = JSON.parse(localStorage.getItem('mock-storage') || '{}');

function getMessage(key, subs = []) {
  const m = messages[key];
  if (!m) return '';
  let text = m.message;
  for (const [name, ph] of Object.entries(m.placeholders || {})) {
    const n = Number(ph.content.slice(1)) - 1;
    text = text.replace(new RegExp(`\\$${name}\\$`, 'gi'), subs[n] ?? '');
  }
  return text;
}

function fakeScreenshot() {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 900;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 1280, 900);
  g.fillStyle = '#1d1d1d'; g.fillRect(0, 0, 1280, 70);
  g.fillStyle = '#ff7a18'; g.fillRect(40, 20, 160, 30);
  g.fillStyle = '#222'; g.font = 'bold 64px sans-serif'; g.fillText('A Complete Guide to Flexbox', 60, 200);
  g.fillStyle = '#888'; for (let i = 0; i < 8; i++) g.fillRect(60, 260 + i * 40, 900 - (i % 3) * 120, 16);
  g.fillStyle = '#7F77DD'; g.fillRect(1000, 240, 220, 300);
  return c.toDataURL('image/jpeg', 0.8);
}

const storageListeners = [];
const messageListeners = [];
globalThis.browser = {
  i18n: { getMessage, getUILanguage: () => lang },
  runtime: {
    getURL: p => {
      if (p.startsWith('_locales/')) return '/src/' + p;
      const [path, query] = p.split('?');
      return `/dev/preview.html?page=${path.split('/')[0]}&lang=${lang}${query ? '&' + query : ''}`;
    },
    sendMessage: async m => {
      console.log('[mock] message', m);
      if (m.type === 'popup-mode') return params.get('mode') || 'save';
      // ?echo=1: the page receives its own change notices, as if they came from another tab.
      if (params.get('echo')) setTimeout(() => messageListeners.forEach(fn => fn(m)), 0);
    },
    onMessage: { addListener: fn => messageListeners.push(fn), removeListener: () => {} },
    openOptionsPage: async () => { location.href = '/dev/preview.html?page=options&lang=' + lang; },
  },
  permissions: {
    contains: async () => params.get('perm') === '1',
    request: async () => { console.log('[mock] permission request'); return false; },
    remove: async () => true,
  },
  downloads: {
    download: async o => { console.log('[mock] download', o.filename); return Math.floor(Math.random() * 1e6); },
    removeFile: async () => {}, erase: async () => {},
    search: async () => [{ state: 'complete' }],
    show: async id => console.log('[mock] show download', id),
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  tabs: {
    query: async () => [{
      id: 1, windowId: 1,
      url: params.get('url') || 'https://css-tricks.com/snippets/css/a-guide-to-flexbox/',
      title: params.get('title') || 'A Complete Guide to Flexbox | CSS-Tricks',
      favIconUrl: '',
    }],
    captureVisibleTab: async () => fakeScreenshot(),
    create: async ({ url }) => { console.log('[mock] open tab', url); },
    update: async (id, o) => { console.log('[mock] update tab', id, o); },
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  windows: { update: async () => {} },
  storage: {
    local: {
      get: async k => {
        const keys = k == null ? Object.keys(store) : Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter(key => key in store).map(key => [key, store[key]]));
      },
      set: async o => {
        const changes = Object.fromEntries(Object.entries(o).map(([key, v]) => [key, { oldValue: store[key], newValue: v }]));
        Object.assign(store, o);
        localStorage.setItem('mock-storage', JSON.stringify(store));
        storageListeners.forEach(fn => fn(changes, 'local'));
      },
    },
    onChanged: { addListener: fn => storageListeners.push(fn), removeListener: fn => storageListeners.splice(storageListeners.indexOf(fn), 1) },
  },
};
window.close = () => console.log('[mock] window.close()');

// ?article=1 gives the newest item a saved article, tags and a favorite (to preview the reader).
if (params.get('article')) {
  const db = await import('/src/lib/db.js');
  const { compressJson, sanitizeHtml } = await import('/src/lib/article.js');
  const [item] = await db.recent(1);
  const html = '<h2>Conceptos básicos</h2><p>El <strong>Flexbox</strong> es un modelo de diseño unidimensional. ' + 'Permite distribuir el espacio entre elementos y alinearlos. '.repeat(12) + '</p><pre><code>.contenedor { display: flex; }</code></pre><blockquote>Una cita de ejemplo sobre diseño.</blockquote><ul><li>Eje principal</li><li>Eje cruzado</li></ul><script>alert(1)</script><p>' + 'Más texto de ejemplo para el lector sin conexión. '.repeat(30) + '</p>';
  await db.setArticle(item.id, await compressJson({ v: 1, title: item.title, byline: 'Chris Coyier', siteName: 'CSS-Tricks', words: 900, html: sanitizeHtml(html, item.url) }));
  await db.updateItem(item.id, { favorite: 1, tags: ['css', 'web'] });
  console.log('[mock] article for', item.id);
}

// ?demo=reset fills the preview database with the demo data used for the store screenshots.
if (params.get('demo') === 'reset') {
  console.log('[mock] demo items', await (await import('/dev/demo.js')).seedDemo());
}

// ?seed=1 imports dev/sample.csv once into the preview database.
if (params.get('seed')) {
  const [{ parseCsv, rowsToRecords }, db] = await Promise.all([import('/src/lib/csv.js'), import('/src/lib/db.js')]);
  const text = await (await fetch('/dev/sample.csv')).text();
  console.log('[mock] seed', await db.importRecords(rowsToRecords(parseCsv(text)).records));
}
