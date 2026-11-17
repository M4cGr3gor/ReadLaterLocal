// Offline reader: shows the saved (sanitised, compressed) article text.
import * as db from '../lib/db.js';
import { applyTheme, saveTheme } from '../lib/theme.js';
import { applyI18n, initI18n, t, uiLocale } from '../lib/i18n.js';
import { decompressJson, sanitizeHtml } from '../lib/article.js';
import { formatDate, hostOf } from '../lib/util.js';
import { getSettings, setSetting } from '../lib/settings.js';
import { el, formatBytes, icon, titleOf, toast } from '../lib/ui.js';
import { fetchItem, hasSitePermission, ALL_URLS } from '../lib/fetcher.js';
import { downloadImages, offlineImagesEnabled } from '../lib/images.js';
import { setupHighlights } from './highlights.js';
import { setupProgress } from './progress.js';
import { emailItem } from '../lib/share.js';
import { saveFile, safeFileName } from '../lib/files.js';

const $ = id => document.getElementById(id);
const root = document.documentElement;
let prefs;
let item;
let highlights = null;
let progress = null;
let article = null; // the article being shown, for "Save as Markdown"
const objectUrls = [];

function applyPrefs() {
  root.dataset.font = prefs.font;
  root.dataset.width = prefs.width;
  root.style.setProperty('--r-size', `${prefs.size}px`);
  $('size-out').textContent = `${prefs.size}px`;
  $('auto-archive').checked = prefs.autoArchive !== false;
  for (const seg of document.querySelectorAll('[data-pref]')) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === prefs[seg.dataset.pref]));
  }
}

async function savePref(key, value) {
  prefs = { ...prefs, [key]: value };
  if (key === 'theme') await saveTheme(value);
  applyPrefs();
  await setSetting('reader', prefs);
}

function renderButtons() {
  const fav = $('fav');
  fav.replaceChildren(icon('star'));
  fav.classList.toggle('on', !!item.favorite);
  fav.title = t(item.favorite ? 'unfavorite' : 'favorite');
  const arch = $('archive');
  const archived = item.status === 'archive';
  arch.replaceChildren(icon(archived ? 'unarchive' : 'archive'));
  arch.title = t(archived ? 'unarchive' : 'archive');
  const img = $('images');
  img.replaceChildren(icon('image'));
  img.setAttribute('aria-pressed', String(!!item.images));
  img.classList.toggle('on', !!item.images);
  img.title = item.images
    ? t('imagesOnTitle', [formatBytes(item.imageBytes || 0, uiLocale())])
    : t(archived ? 'imagesArchived' : 'imagesOffTitle');
}

async function load() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  item = await db.getItem(id);
  if (!item) { $('missing').hidden = false; return; }
  document.title = titleOf(item);
  $('original').href = item.url;
  $('original').prepend(icon('external'));
  renderButtons();

  const blob = await db.getArticle(id);
  if (!blob) {
    $('title').textContent = titleOf(item);
    return offerDownload();
  }
  render(await decompressJson(blob));
}

// No saved text yet (e.g. imported from a CSV): download it now.
async function downloadArticle() {
  $('fetch-msg').textContent = t('fetchingArticle');
  $('fetch-btn').hidden = true;
  const result = await fetchItem(item, new AbortController().signal).catch(() => 'failed');
  item = await db.getItem(item.id);
  renderButtons();
  const blob = result === 'ok' ? await db.getArticle(item.id) : null;
  if (!blob) {
    $('fetch-msg').textContent = t('articleFailed');
    return;
  }
  $('fetch-box').hidden = true;
  render(await decompressJson(blob));
}

async function offerDownload() {
  $('fetch-box').hidden = false;
  $('fetch-web').href = item.url;
  if (await hasSitePermission()) return downloadArticle();
  $('fetch-msg').textContent = t('articleNeedsPermission');
  $('fetch-btn').onclick = async () => {
    // Must be called straight from the click so Firefox shows its permission prompt.
    if (await browser.permissions.request(ALL_URLS)) downloadArticle();
    else $('fetch-msg').textContent = t('fetchDenied');
  };
}

function render(art) {
  // The article keeps its own language and direction, whatever the extension's language is.
  for (const part of [$('title'), $('content')]) {
    if (art.lang) part.lang = art.lang;
    part.dir = 'auto';
  }
  $('site').textContent = art.siteName || hostOf(item.url);
  $('title').textContent = art.title || titleOf(item);
  document.title = $('title').textContent;
  const minutes = Math.max(1, Math.round((art.words || 0) / 220));
  $('meta').textContent = [art.byline, formatDate(item.time_added, uiLocale()), t('readingTime', [String(minutes)])].filter(Boolean).join(' · ');
  // Sanitised when saved; sanitised again here in case the data came from a backup file.
  const doc = new DOMParser().parseFromString(sanitizeHtml(art.html, item.url), 'text/html');
  $('content').replaceChildren(...doc.body.childNodes);
  $('print-url').textContent = item.url;
  $('images').hidden = false;
  // Saved with the wrong character set before v1.6.1: offer to download it again.
  $('repair-note').hidden = ((art.html || '') + (art.title || '')).split('\uFFFD').length <= 3;
  renderButtons();
  showOfflineImages();
  highlights ??= setupHighlights({ root: $('content'), item, panel: $('hl-panel'), toggle: $('hl-toggle'), countEl: $('hl-count'), toasts: $('toasts'), color: () => prefs.hlColor || 'yellow', mode: () => !!prefs.hlMode });
  highlights.render();
  article = art;
  $('listen').hidden = !('speechSynthesis' in globalThis);
  progress ??= setupProgress({ id: item.id, bar: $('read-progress'), content: $('content'), onFinish: finishArticle });
  progress.restore();
  autoSaveImages();
}

// Reaching the end (scrolling or listening) archives the article, if that option is on.
async function finishArticle() {
  if (!prefs.autoArchive || item.status !== 'unread') return;
  const hadImages = !!item.images;
  item = await db.updateItem(item.id, { status: 'archive' });
  renderButtons();
  progress?.forget();
  toast($('toasts'), t(hadImages ? 'finishedArchivedImages' : 'finishedArchived'), {
    label: t('undo'),
    run: async () => { item = await db.updateItem(item.id, { status: 'unread' }); renderButtons(); },
  });
}

// With the general switch on, an article opened without its pictures gets them now
// (unless the user removed them for this article).
async function autoSaveImages() {
  if (item.images || item.noImages || item.status === 'archive' || !item.hasArticle) return;
  if (!(await offlineImagesEnabled()) || !(await hasSitePermission())) return;
  saveImages();
}

$('repair-btn').addEventListener('click', () => {
  browser.permissions.request(ALL_URLS).then(async granted => {
    if (!granted) return toast($('toasts'), t('fetchDenied'));
    $('repair-btn').disabled = true;
    toast($('toasts'), t('fetchingArticle'));
    const result = await fetchItem(item, new AbortController().signal).catch(() => 'failed');
    if (result === 'ok') location.reload();
    else { $('repair-btn').disabled = false; toast($('toasts'), t('articleFailed')); }
  });
});

// Kept in step with changes made in other tabs ("View all", the popup…).
browser.runtime.onMessage.addListener(async message => {
  if (message?.type !== 'items-changed' || !item) return;
  if (Array.isArray(message.ids) && !message.ids.includes(item.id)) return;
  const fresh = await db.getItem(item.id);
  if (!fresh) return;
  const imagesChanged = fresh.images !== item.images;
  item = fresh;
  highlights?.setItem(fresh);
  renderButtons();
  if (imagesChanged) showOfflineImages();
});

// Pictures saved for offline reading replace the web addresses (the original stays in data-src).
async function showOfflineImages() {
  const imgs = [...$('content').querySelectorAll('img')];
  for (const img of imgs) if (!img.dataset.src) img.dataset.src = img.getAttribute('src');
  while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
  const saved = item.images ? await db.getImages(item.id) : new Map();
  for (const img of imgs) {
    const blob = saved.get(img.dataset.src);
    if (blob) {
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      img.src = url;
    } else {
      img.src = img.dataset.src;
    }
  }
}

$('images').addEventListener('click', () => {
  if (item.images) return removeImages();
  if (item.status === 'archive') return toast($('toasts'), t('imagesArchived'));
  // Asked straight from the click so Firefox can show its prompt (resolves at once if granted).
  browser.permissions.request(ALL_URLS).then(granted => {
    if (!granted) return toast($('toasts'), t('fetchDenied'));
    return saveImages();
  });
});

async function saveImages() {
  const btn = $('images');
  btn.disabled = true;
  toast($('toasts'), t('imagesSaving'));
  try {
    const res = await downloadImages(item.id, {
      onProgress: (done, total) => toast($('toasts'), t('imagesProgress', [String(done), String(total)])),
    });
    item = await db.getItem(item.id);
    renderButtons();
    showOfflineImages();
    const size = formatBytes(res?.bytes || 0, uiLocale());
    if (!res?.total) toast($('toasts'), t('imagesNone'));
    else if (!res.count) toast($('toasts'), t('imagesFailed'));
    else toast($('toasts'), t(res.count < res.total ? 'imagesSavedSome' : 'imagesSaved', [String(res.count), size, String(res.total)]));
  } finally {
    btn.disabled = false;
  }
}

async function removeImages() {
  item = await db.deleteImages(item.id);
  renderButtons();
  showOfflineImages();
  toast($('toasts'), t('imagesRemoved'));
}

$('print').prepend(icon('printer'));
$('email').prepend(icon('mail'));
$('copy-md').prepend(icon('copy'));
$('save-md').prepend(icon('markdown'));
$('more').append(icon('dots'));
$('listen').append(icon('speaker'));

// ---- "More" menu: print, email, Markdown ----
const moreMenu = $('more-menu');
const toggleMore = open => {
  moreMenu.hidden = !(open ?? moreMenu.hidden);
  $('more').setAttribute('aria-expanded', String(!moreMenu.hidden));
};
$('more').addEventListener('click', e => { e.stopPropagation(); toggleMore(); });
moreMenu.addEventListener('click', () => toggleMore(false));
document.addEventListener('click', e => { if (!moreMenu.hidden && !e.target.closest('#more, #more-menu')) toggleMore(false); });

$('copy-md').addEventListener('click', async () => {
  if (!item) return;
  const { linkMarkdown } = await import('../lib/markdown.js');
  await navigator.clipboard.writeText(linkMarkdown(item));
  toast($('toasts'), t('markdownCopied'));
});
$('save-md').addEventListener('click', async () => {
  if (!item || !article) return;
  const { articleMarkdown } = await import('../lib/markdown.js');
  const text = articleMarkdown(item, article, await db.getHighlights(item.id), { highlights: t('hlPanel') });
  const name = safeFileName(article.title || titleOf(item), 'md');
  const id = await saveFile(new Blob([text], { type: 'text/markdown;charset=utf-8' }), name, { saveAs: true });
  if (id != null) toast($('toasts'), t('markdownSaved', [name]));
});

// ---- Listen: the system's voices read the article aloud ----
let speech = null; // loaded the first time it's used
async function setupSpeech() {
  const tts = await import('./tts.js');
  const voices = await tts.loadVoices();
  if (!voices.length) { toast($('toasts'), t('ttsNoVoices')); return null; }
  const lang = $('content').lang || uiLocale();
  const base = lang.split('-')[0].toLowerCase();
  // Voices for the article's language first.
  const sorted = [...voices].sort((a, b) =>
    (b.lang.toLowerCase().startsWith(base) - a.lang.toLowerCase().startsWith(base)) || a.name.localeCompare(b.name));
  let voice = tts.pickVoice(voices, lang, prefs.ttsVoice);
  $('tts-voice').replaceChildren(...sorted.map(v => el('option', { value: v.voiceURI }, `${v.name} (${v.lang})`)));
  if (voice) $('tts-voice').value = voice.voiceURI;
  $('tts-rate').replaceChildren(...tts.RATES.map(r => el('option', { value: String(r) }, `${new Intl.NumberFormat(uiLocale()).format(r)}×`)));
  $('tts-rate').value = String(tts.RATES.includes(prefs.ttsRate) ? prefs.ttsRate : 1);
  const reader = tts.createReader({
    root: $('content'),
    getVoice: () => voice,
    getRate: () => Number($('tts-rate').value) || 1,
    onChange: ({ playing, active }) => {
      $('tts-bar').hidden = !active;
      $('listen').setAttribute('aria-pressed', String(active));
      $('listen').classList.toggle('on', active);
      $('tts-play').replaceChildren(icon(playing ? 'pause' : 'play'));
      $('tts-play').title = t(playing ? 'ttsPause' : 'ttsPlay');
      if (playing) progress?.engage();
    },
    onEnd: finishArticle,
    onError: () => toast($('toasts'), t('ttsError')),
  });
  $('tts-voice').addEventListener('change', () => {
    voice = voices.find(v => v.voiceURI === $('tts-voice').value) || voice;
    savePref('ttsVoice', voice?.voiceURI || '');
    reader.restart();
  });
  $('tts-rate').addEventListener('change', () => { savePref('ttsRate', Number($('tts-rate').value) || 1); reader.restart(); });
  $('tts-play').addEventListener('click', () => reader.toggle());
  $('tts-prev').addEventListener('click', () => reader.prev());
  $('tts-next').addEventListener('click', () => reader.next());
  $('tts-stop').addEventListener('click', () => reader.stop());
  return reader;
}
$('tts-prev').append(icon('prev'));
$('tts-next').append(icon('next'));
$('tts-stop').append(icon('stop'));
$('listen').addEventListener('click', async () => {
  speech ??= await setupSpeech();
  if (!speech) return;
  if (speech.active) speech.stop();
  else speech.play();
});
$('email').addEventListener('click', async () => {
  if (!item) return;
  const file = await emailItem(item, { attach: t('emailAttach'), highlights: t('hlPanel') });
  toast($('toasts'), file ? t('emailFileSaved', [file]) : t('emailLinkOnly'));
});
$('print').addEventListener('click', () => window.print());
$('hl-toggle').prepend(icon('note'));
$('hl-mode').append(icon('highlight'));

// Highlighter mode: selecting text highlights it at once. The H key (with nothing selected) switches it.
function renderHlMode() {
  $('hl-mode').setAttribute('aria-pressed', String(!!prefs.hlMode));
  $('hl-mode').classList.toggle('on', !!prefs.hlMode);
  document.documentElement.classList.toggle('hl-mode', !!prefs.hlMode);
}
async function toggleHlMode() {
  await savePref('hlMode', !prefs.hlMode);
  renderHlMode();
  toast($('toasts'), t(prefs.hlMode ? 'hlModeOn' : 'hlModeOff'));
}
$('hl-mode').addEventListener('click', toggleHlMode);
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'h' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea')) return;
  if (!document.getSelection().isCollapsed) return; // with a selection, H highlights it (highlights.js)
  e.preventDefault();
  toggleHlMode();
});
document.addEventListener('click', e => {
  const p = $('hl-panel');
  if (!p.hidden && !p.contains(e.target) && !e.target.closest('#hl-toggle, .hl-bar, .hl-note')) {
    p.hidden = true;
    $('hl-toggle').setAttribute('aria-expanded', 'false');
  }
});

$('fav').addEventListener('click', async () => {
  item = await db.updateItem(item.id, { favorite: item.favorite ? 0 : 1 });
  renderButtons();
  toast($('toasts'), t(item.favorite ? 'addedToFavorites' : 'removedFromFavorites'));
});
$('archive').addEventListener('click', async () => {
  const hadImages = !!item.images;
  item = await db.updateItem(item.id, { status: item.status === 'archive' ? 'unread' : 'archive' });
  renderButtons();
  if (hadImages && !item.images) showOfflineImages();
  toast($('toasts'), t(item.status === 'archive' ? (hadImages ? 'archivedImagesGone' : 'archived') : 'movedToUnread'));
});

const panel = $('panel');
$('settings').addEventListener('click', e => {
  e.stopPropagation();
  panel.hidden = !panel.hidden;
  $('settings').setAttribute('aria-expanded', String(!panel.hidden));
});
document.addEventListener('click', e => { if (!panel.hidden && !e.target.closest('#settings, #panel')) panel.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { panel.hidden = true; toggleMore(false); } });
for (const seg of document.querySelectorAll('[data-pref]')) {
  for (const b of seg.querySelectorAll('button')) b.addEventListener('click', () => savePref(seg.dataset.pref, b.dataset.value));
}
$('smaller').addEventListener('click', () => savePref('size', Math.max(14, prefs.size - 1)));
$('auto-archive').addEventListener('change', e => savePref('autoArchive', e.target.checked));
$('bigger').addEventListener('click', () => savePref('size', Math.min(28, prefs.size + 1)));

await Promise.all([initI18n(), applyTheme()]);
applyI18n();
prefs = { ...(await getSettings()).reader, theme: root.dataset.theme };
applyPrefs();
renderHlMode();
load().catch(err => { console.error(err); $('missing').hidden = false; });
