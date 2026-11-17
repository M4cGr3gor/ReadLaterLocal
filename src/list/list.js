// "View all": filters, infinite scroll (30 at a time), selection mode and per-item actions.
import * as db from '../lib/db.js';
import { applyTheme } from '../lib/theme.js';
import { applyI18n, initI18n, t, uiLocale } from '../lib/i18n.js';
import { formatDate, hostOf, normalize, normalizeTags, nowSeconds, parseQuery } from '../lib/util.js';
import { readingMinutes } from '../lib/classify.js';
import { daysLeft, EXPIRE_CHOICES, runCleanup } from '../lib/cleanup.js';
import { emailItem } from '../lib/share.js';
import { suggestTags } from '../lib/suggest.js';
import { exportAs, importFile, IMPORT_ACCEPT } from '../lib/transfer.js';
import { getSettings, setSetting } from '../lib/settings.js';
import { loadCollections, createCollection, collectionName } from '../lib/collections.js';
import { ALL_URLS, hasSitePermission } from '../lib/fetcher.js';
import { backfillTexts, backfillWordCounts, runBackgroundFetch } from '../lib/bgfetch.js';
import { el, icon, thumbTile, titleOf, toast, readerUrl, openDataPage } from '../lib/ui.js';

const PAGE_SIZE = 30;
const FACET_LIMIT = 20;
const $ = id => document.getElementById(id);
const listEl = $('items');
const toasts = $('toasts');
const search = $('search');

const state = {
  status: 'unread',
  query: '',
  kind: '',
  collection: '',
  order: 'newest',
  short: false,
  next: null,       // cursor for the next batch
  done: false,
  loading: false,
  generation: 0,    // bumps on every reset so stale batches are dropped
  focus: -1,        // keyboard-selected card index
  selecting: false,
  selected: new Set(),
  lastClicked: -1,
  facet: 'tags',
  facetExpanded: false,
  view: 'grid',
  size: 'm',        // thumbnail size: s, m, l
};
const SIZES = ['s', 'm', 'l'];
const inTrash = () => state.status === 'trash';
let collections = [];
let stats = { siteTags: new Map(), allTags: [] };

const filters = () => ({
  status: state.status, query: state.query, kind: state.kind,
  collection: state.collection, short: state.short, order: state.order,
});

// ---- thumbnails: load only when a card scrolls into view ----
const thumbObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    e.target._load?.();
  }
}, { rootMargin: '300px' });

// A card that leaves the page must not stay referenced by the observer.
const forgetThumb = card => { const tile = card.querySelector('.thumb'); if (tile) thumbObserver.unobserve(tile); };

const cards = () => [...listEl.children];
const cardById = id => listEl.querySelector(`.card[data-id="${id}"]`);

function leavesView(item) {
  const f = filters();
  if (f.status === 'favorite' && !item.favorite) return true;
  if ((f.status === 'unread' || f.status === 'archive') && item.status !== f.status) return true;
  if (f.collection === '-' && item.collection) return true;
  if (f.collection && f.collection !== '-' && item.collection !== f.collection) return true;
  return false;
}

function replaceCard(card, item) {
  if (!card) return;
  if (!item) { removeCard(card); return; }
  if (leavesView(item)) { removeCard(card); return; }
  const fresh = cardFor(item, card);
  for (const c of ['focused', 'selected']) if (card.classList.contains(c)) fresh.classList.add(c);
  forgetThumb(card);
  card.replaceWith(fresh);
}

function removeCard(card) {
  const idx = cards().indexOf(card);
  forgetThumb(card);
  card.remove();
  if (state.focus >= 0) setFocus(Math.min(idx, cards().length - 1), false);
  checkEmpty();
}

function chip(text, onclick, extra = '') {
  return el('button', { class: `tag-chip ${extra}`, type: 'button', onclick: e => { e.preventDefault(); e.stopPropagation(); onclick(); } }, text);
}

function cardFor(item, old = null) {
  const archived = item.status === 'archive';
  const tile = thumbTile(item, { lazy: true, from: old?.querySelector('.thumb') });
  thumbObserver.observe(tile);
  const card = el('li', { class: `card${state.selected.has(item.id) ? ' selected' : ''}`, tabindex: '-1', dataset: { id: item.id } });
  card._item = item;
  const action = (name, label, fn, cls = '') => el('button', {
    class: `icon-btn ${cls}`, type: 'button', title: label, 'aria-label': label,
    onclick: e => { e.preventDefault(); e.stopPropagation(); fn(item, card, e.currentTarget); },
  }, icon(name));
  const link = (...kids) => el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', title: item.url }, ...kids);
  const host = hostOf(item.url);
  const minutes = readingMinutes(item.words);
  const colName = collectionName(collections, item.collection);
  const locale = uiLocale();

  card.append(
    el('span', { class: 'check', 'aria-hidden': 'true' }, icon('check')),
    el('div', { class: 'thumb-wrap' },
      link(tile),
      item.favorite || colName ? el('div', { class: 'thumb-badges' },
        item.favorite ? el('span', { class: 'ov ov-fav', title: t('filterFavorite'), 'aria-label': t('filterFavorite') }, icon('star')) : null,
        colName ? el('button', {
          class: 'ov ov-col', type: 'button', title: `${t('collectionFilterBy')}: ${colName}`,
          onclick: e => { e.preventDefault(); e.stopPropagation(); filterByCollection(item.collection); },
        }, icon('folder'), el('span', {}, colName)) : null) : null),
    el('div', { class: 'card-body' },
      link(el('div', { class: 'card-title', dir: 'auto' }, titleOf(item))),
      item.note ? el('div', { class: 'card-note', title: item.note }, item.note) : null,
      item.tags?.length ? el('div', { class: 'card-tags' }, item.tags.map(tag => chip(tag, () => toggleToken('tag', tag)))) : null,
      el('div', { class: 'card-meta' },
        item._inText ? el('span', { class: 'badge badge-intext', title: t('matchInTextTitle') }, icon('search'), t('matchInText')) : null,
        item.hasArticle ? el('span', { class: 'badge badge-offline', title: item.images ? t('readerWithImages') : t('reader') }, icon('book'), item.images ? icon('image') : null) : null,
        item.hl ? el('span', { class: 'badge badge-hl', title: t('hlCount', [String(item.hl)]) }, icon('highlight'), String(item.hl)) : null,
        colName ? el('span', { class: 'badge badge-col list-only', title: colName }, icon('folder'), colName) : null,
        item.expires ? el('span', { class: 'badge badge-expire', title: t('expiresOn', [formatDate(item.expires, locale)]) }, icon('hourglass'), formatDate(item.expires, locale)) : null,
        el('span', { class: 'host' },
          el('button', { class: 'site-link', type: 'button', title: `site:${host}`, onclick: e => { e.preventDefault(); e.stopPropagation(); toggleToken('site', host); } }, host),
          ` · ${formatDate(item.time_added, locale)}${minutes ? ' · ' + t('minutes', [String(minutes)]) : ''}`),
        el('span', { class: 'card-actions' },
          action('book', t('reader'), openReader),
          action('star', item.favorite ? t('unfavorite') : t('favorite'), toggleFavorite, item.favorite ? 'on' : ''),
          action(archived ? 'unarchive' : 'archive', archived ? t('unarchive') : t('archive'), toggleArchive),
          action('trash', t('delete'), remove, 'danger'),
          action('dots', t('more'), openCardMenu)))),
  );
  card.addEventListener('mousedown', () => setFocus(cards().indexOf(card), false));
  return card;
}

// ---- per-item actions ----
function openWeb(item) { browser.tabs.create({ url: item.url }); }

function openReader(item) {
  const open = () => browser.tabs.create({ url: readerUrl(item.id) });
  if (item.hasArticle) return open();
  // No saved text yet: ask for site access right from the click (Firefox needs the user
  // gesture); the reader then downloads the article. If refused, the reader explains.
  browser.permissions.request(ALL_URLS).catch(() => false).finally(open);
}

async function toggleFavorite(item, card) {
  const updated = await db.updateItem(item.id, { favorite: item.favorite ? 0 : 1 });
  replaceCard(card, updated);
  refreshCounts();
  toast(toasts, t(updated.favorite ? 'addedToFavorites' : 'removedFromFavorites'));
}

async function toggleArchive(item, card) {
  const status = item.status === 'archive' ? 'unread' : 'archive';
  const updated = await db.updateItem(item.id, { status });
  replaceCard(card, updated);
  refreshCounts();
  toast(toasts, t(status === 'archive' ? 'archived' : 'movedToUnread'), {
    label: t('undo'),
    run: async () => { await db.updateItem(item.id, { status: item.status }); reset(); },
  });
}

// "Delete in…": after that date the next cleanup moves the item to the trash.
function expirePicker(current) {
  const sel = el('select', { 'aria-label': t('expireSet') },
    ...EXPIRE_CHOICES.map(([key, secs]) => el('option', { value: String(secs) }, t(key))),
    current ? el('option', { value: '0' }, t('expireNever')) : null);
  sel.value = String(30 * 86400);
  return [sel, el('p', { class: 'dialog-help' }, t('expireHelp'))];
}
const expiresFrom = value => (Number(value) > 0 ? nowSeconds() + Number(value) : 0);

async function scheduleDelete(item, card) {
  const nodes = expirePicker(item.expires);
  if (!(await promptDialog(item.expires ? t('expireChange') : t('expireSet'), ...nodes))) return;
  const expires = expiresFrom(nodes[0].value);
  const updated = await db.updateItem(item.id, { expires });
  replaceCard(card, updated);
  toast(toasts, expires ? t('expireScheduled', [formatDate(expires, uiLocale())]) : t('expireCancelled'));
}

async function remove(item, card) {
  const trashed = await db.trashItems([item.id]);
  removeCard(card);
  refreshCounts();
  toast(toasts, t('deleted'), {
    label: t('undo'),
    run: async () => { await db.undoTrash(trashed); reset(); },
  });
}

// Inline editor inside a card (tags or note). Enter / Ctrl+Enter saves, Esc cancels.
function inlineEditor(item, card, { field, multiline, placeholder, help, suggestions = [], save }) {
  const body = card.querySelector('.card-body');
  if (body.querySelector('.editor')) return;
  const input = multiline
    ? el('textarea', { placeholder, 'aria-label': placeholder, maxlength: '5000' })
    : el('input', { type: 'text', placeholder, 'aria-label': placeholder, list: 'tag-suggestions' });
  input.value = field;
  const editor = el('div', { class: 'editor' }, input);
  if (suggestions.length) {
    editor.append(el('div', { class: 'suggest' }, t('suggested'), ...suggestions.map(s => chip(s, () => {
      input.value = [...normalizeTags(input.value), s].join(', ');
      input.focus();
    }))));
  }
  editor.append(el('small', {}, help));
  body.querySelector('.card-tags')?.remove();
  body.querySelector('.card-note')?.remove();
  body.querySelector('.card-meta').before(editor);
  let finished = false;
  const finish = async ok => {
    if (finished) return;
    finished = true;
    if (!ok) { replaceCard(card, item); return; }
    replaceCard(card, await save(input.value));
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') finish(false);
    if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); finish(true); }
  });
  // Clicking a suggestion briefly blurs the input; give it a moment before saving.
  input.addEventListener('blur', () => setTimeout(() => { if (!editor.contains(document.activeElement)) finish(true); }, 150));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function editTags(item, card) {
  inlineEditor(item, card, {
    field: (item.tags || []).join(', '),
    placeholder: t('tagsPlaceholder'),
    help: t('tagsHelp'),
    suggestions: suggestTags(item, stats),
    save: async value => {
      const updated = await db.updateItem(item.id, { tags: normalizeTags(value) });
      refreshFacets();
      toast(toasts, t('tagsSaved'));
      return updated;
    },
  });
}

function editNote(item, card) {
  inlineEditor(item, card, {
    field: item.note || '',
    multiline: true,
    placeholder: t('notePlaceholder'),
    help: t('noteHelp'),
    save: async value => {
      const updated = await db.updateItem(item.id, { note: value.trim().slice(0, 5000) });
      toast(toasts, t('noteSaved'));
      return updated;
    },
  });
}

// ---- small dialog used for "move to collection" and bulk tagging ----
function promptDialog(title, ...body) {
  const dlg = $('prompt');
  $('prompt-title').textContent = title;
  $('prompt-body').replaceChildren(...body);
  dlg.returnValue = '';
  dlg.showModal();
  body.find(n => n.matches?.('input, select'))?.focus();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

function collectionPicker(current = '') {
  const sel = el('select', { 'aria-label': t('moveToCollection') },
    el('option', { value: '' }, t('collectionNone')),
    ...collections.map(c => el('option', { value: c.id }, c.name)),
    el('option', { value: '__new' }, t('collectionNew')));
  sel.value = current;
  const name = el('input', { type: 'text', placeholder: t('collectionNamePrompt'), hidden: true, maxlength: '60' });
  sel.addEventListener('change', () => { name.hidden = sel.value !== '__new'; if (!name.hidden) name.focus(); });
  return {
    nodes: [sel, name],
    value: async () => {
      if (sel.value !== '__new') return sel.value;
      const col = await createCollection(name.value);
      collections = await loadCollections();
      renderCollectionFilter();
      return col?.id ?? null;
    },
  };
}

async function moveToCollection(item, card) {
  const picker = collectionPicker(item.collection);
  if (!(await promptDialog(t('moveToCollection'), ...picker.nodes))) return;
  const id = await picker.value();
  if (id === null) return;
  const updated = await db.updateItem(item.id, { collection: id });
  replaceCard(card, updated);
  toast(toasts, id ? t('movedToCollection', [collectionName(collections, id)]) : t('removedFromCollection'));
}

async function emailFromList(item) {
  const file = await emailItem(item, { attach: t('emailAttach'), highlights: t('hlPanel') });
  toast(toasts, file ? t('emailFileSaved', [file]) : t('emailLinkOnly'));
}

async function copyLink(item) {
  await navigator.clipboard.writeText(item.url);
  toast(toasts, t('linkCopied'));
}

async function copyMarkdown(item) {
  const { linkMarkdown } = await import('../lib/markdown.js');
  await navigator.clipboard.writeText(linkMarkdown(item));
  toast(toasts, t('markdownCopied'));
}

// "More actions" menu next to a card.
const cardMenu = $('card-menu');
function openCardMenu(item, card, anchor) {
  const entry = (name, label, fn) => el('button', { type: 'button', role: 'menuitem', onclick: e => { e.stopPropagation(); closeCardMenu(); fn(item, card); } }, icon(name), label);
  cardMenu.replaceChildren(
    entry('note', t('editNote'), editNote),
    entry('tag', t('editTags'), editTags),
    entry('folder', t('moveToCollection'), moveToCollection),
    entry('hourglass', item.expires ? t('expireChange') : t('expireSet'), scheduleDelete),
    entry('mail', t('emailSend'), emailFromList),
    entry('link', t('copyLink'), copyLink),
    entry('markdown', t('copyMarkdown'), copyMarkdown),
    entry('external', t('openOriginal'), openWeb),
  );
  const r = anchor.getBoundingClientRect();
  cardMenu.hidden = false;
  const w = cardMenu.offsetWidth;
  cardMenu.style.top = `${r.bottom + window.scrollY + 4}px`;
  cardMenu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + window.scrollX}px`;
  cardMenu.style.right = 'auto';
  cardMenu.querySelector('button').focus();
}
function closeCardMenu() { cardMenu.hidden = true; }
document.addEventListener('click', e => { if (!cardMenu.hidden && !cardMenu.contains(e.target)) closeCardMenu(); });
cardMenu.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCardMenu(); e.stopPropagation(); } });

// ---- search tokens (tag:, site:) ----
function toggleToken(kind, value) {
  const token = `${kind}:${value}`.toLowerCase();
  const parts = search.value.split(/\s+/).filter(Boolean);
  const has = parts.some(p => p.toLowerCase() === token);
  search.value = (has ? parts.filter(p => p.toLowerCase() !== token) : [...parts, `${kind}:${value}`]).join(' ') + (has ? '' : ' ');
  state.query = search.value;
  reset();
}

// ---- tags / sites bar ----
async function refreshFacets() {
  const facets = await db.facetStats(); // one pass for the bar and the tag suggestions
  stats = { siteTags: facets.siteTags, allTags: facets.allTags };
  const bar = $('facet-bar');
  $('tab-tags').setAttribute('aria-pressed', String(state.facet === 'tags'));
  $('tab-sites').setAttribute('aria-pressed', String(state.facet === 'sites'));
  const q = parseQuery(search.value);
  const entries = state.facet === 'tags'
    ? facets.tags.map(({ tag, count }) => ({ key: tag, count, on: q.tags.includes(tag), kind: 'tag' }))
    : facets.sites.map(({ site, count }) => ({ key: site, count, on: q.sites.includes(site), kind: 'site' }));
  const shown = state.facetExpanded ? entries : entries.slice(0, FACET_LIMIT);
  bar.replaceChildren(...shown.map(e => {
    const b = chip(e.key, () => toggleToken(e.kind, e.key), e.on ? 'on' : '');
    b.append(el('span', { class: 'n' }, String(e.count)));
    return b;
  }));
  if (entries.length > FACET_LIMIT) {
    bar.append(chip(state.facetExpanded ? t('showLess') : `${t('showMore')} (${entries.length - FACET_LIMIT})`, () => {
      state.facetExpanded = !state.facetExpanded;
      refreshFacets();
    }, 'more'));
  }
  if (!entries.length) bar.append(el('span', { class: 'tag-chip' }, '—'));
  const dl = $('tag-suggestions') || document.body.appendChild(el('datalist', { id: 'tag-suggestions' }));
  dl.replaceChildren(...stats.allTags.map(tag => el('option', { value: tag })));
}

for (const [id, facet] of [['tab-tags', 'tags'], ['tab-sites', 'sites']]) {
  $(id).addEventListener('click', () => {
    state.facet = facet;
    state.facetExpanded = false;
    setSetting('listFacet', facet);
    refreshFacets();
  });
}

// ---- paging ----
async function loadMore() {
  if (state.loading || state.done || inTrash()) return;
  state.loading = true;
  $('loading').hidden = false;
  const gen = state.generation;
  try {
    const { items, next } = await db.page({ ...filters(), after: state.next, limit: PAGE_SIZE });
    if (gen !== state.generation) return;
    listEl.append(...items.map(item => cardFor(item)));
    state.next = next;
    state.done = !next;
  } finally {
    if (gen === state.generation) {
      state.loading = false;
      $('loading').hidden = true;
      checkEmpty();
      // If the batch doesn't fill the screen, the sentinel stays visible: keep going.
      if (!state.done && isSentinelVisible()) loadMore();
    }
  }
}

function isSentinelVisible() {
  return $('sentinel').getBoundingClientRect().top < window.innerHeight + 400;
}

new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) loadMore();
}, { rootMargin: '400px' }).observe($('sentinel'));
// Belt and braces: a plain scroll check in case the observer misses a fast jump to the end.
let scrollQueued = false;
window.addEventListener('scroll', () => {
  if (scrollQueued) return;
  scrollQueued = true;
  setTimeout(() => { scrollQueued = false; if (isSentinelVisible()) loadMore(); }, 150);
}, { passive: true });

function reset() {
  state.generation++;
  state.next = null;
  state.done = false;
  state.loading = false;
  state.focus = -1;
  closeCardMenu();
  thumbObserver.disconnect(); // the old cards go: stop watching them
  listEl.replaceChildren();
  refreshCounts();
  if (inTrash()) { renderTrash(); return; }
  refreshFacets();
  loadMore();
}

// ---- trash: what automatic cleanup removed (title and address only), kept 30 days ----
async function renderTrash() {
  const gen = state.generation;
  const q = normalize(search.value.trim());
  const rows = (await db.listTrash()).filter(r => !q || normalize(`${r.title} ${r.url}`).includes(q));
  if (gen !== state.generation) return;
  const locale = uiLocale();
  listEl.replaceChildren(...rows.map(r => {
    const host = hostOf(r.url);
    const left = daysLeft(r.deletedAt);
    return el('li', { class: 'card trash-row', tabindex: '-1' },
      el('div', { class: 'card-body' },
        el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', title: r.url }, el('div', { class: 'card-title' }, r.title || r.url)),
        el('div', { class: 'card-meta' }, el('span', { class: 'host' },
          `${host} · ${t('trashDeletedOn', [formatDate(Math.floor(r.deletedAt / 1000), locale)])} · ${left ? t('trashDaysLeft', [String(left)]) : t('trashToday')}`))),
      el('span', { class: 'trash-actions' },
        el('button', { class: 'btn', type: 'button', onclick: async () => {
          await db.restoreFromTrash([r.id]);
          toast(toasts, t('trashRestored'));
          reset();
          startBackgroundFetch();
        } }, icon('unarchive'), t('restore')),
        el('button', { class: 'icon-btn danger', type: 'button', title: t('deleteForever'), 'aria-label': t('deleteForever'), onclick: async () => {
          await db.deleteFromTrash([r.id]);
          reset();
        } }, icon('trash'))));
  }));
  state.done = true;
  $('trash-info').hidden = false;
  $('empty-trash').disabled = !rows.length;
  $('empty').hidden = rows.length > 0;
  $('empty-title').textContent = q ? t('noResults') : t('trashEmpty');
  $('empty-body').textContent = q ? '' : t('trashEmptyBody');
}

$('empty-trash').addEventListener('click', async () => {
  const n = await db.trashCount();
  if (!(await promptDialog(t('emptyTrash'), el('p', {}, t('emptyTrashConfirm', [String(n)]))))) return;
  await db.purgeTrash();
  reset();
});

function checkEmpty() {
  const isEmpty = state.done && listEl.children.length === 0;
  $('empty').hidden = !isEmpty;
  if (isEmpty) {
    const filtered = state.query || state.kind || state.collection || state.short;
    $('empty-title').textContent = filtered ? t('noResults') : t('emptyListTitle');
    $('empty-body').textContent = filtered ? '' : t('emptyListBody');
  }
}

async function refreshCounts() {
  const c = await db.counts();
  for (const span of document.querySelectorAll('[data-count]')) span.textContent = c[span.dataset.count];
  $('trash-count').hidden = !c.trash;
  $('trash-count').textContent = c.trash > 99 ? '99+' : String(c.trash);
  $('trash-btn').title = `${t('filterTrash')} (${c.trash})`;
}

// ---- filters, search, view ----
function selectStatus(status) {
  const wasTrash = inTrash();
  state.status = status;
  for (const c of document.querySelectorAll('.chip[data-status]')) c.setAttribute('aria-selected', String(c.dataset.status === status));
  const trash = inTrash();
  if (trash && state.selecting) setSelecting(false);
  document.body.classList.toggle('trash-view', trash);
  $('select-mode').disabled = trash;
  $('triage-btn').disabled = trash;
  $('surprise').disabled = trash;
  $('trash-info').hidden = !trash;
  $('trash-btn').setAttribute('aria-pressed', String(trash));
  if (trash || wasTrash) applyListClass();
  reset();
}

function filterByCollection(id) {
  state.collection = id;
  renderCollectionFilter();
  reset();
  window.scrollTo({ top: 0 });
}
for (const c of document.querySelectorAll('.chip[data-status]')) c.addEventListener('click', () => selectStatus(c.dataset.status));

$('short').addEventListener('click', () => {
  state.short = !state.short;
  $('short').setAttribute('aria-pressed', String(state.short));
  reset();
});
$('kind').addEventListener('change', e => { state.kind = e.target.value; reset(); });
$('order').addEventListener('change', e => { state.order = e.target.value; setSetting('listOrder', state.order); reset(); });

function renderCollectionFilter() {
  const sel = $('collection');
  sel.replaceChildren(
    el('option', { value: '' }, t('collectionAll')),
    el('option', { value: '-' }, t('collectionNone')),
    ...collections.map(c => el('option', { value: c.id }, c.name)),
    el('option', { value: '__new' }, t('collectionNew')));
  sel.value = collections.some(c => c.id === state.collection) || ['', '-'].includes(state.collection) ? state.collection : '';
}
$('collection').addEventListener('change', async e => {
  if (e.target.value === '__new') {
    const name = el('input', { type: 'text', maxlength: '60', placeholder: t('collectionNamePrompt') });
    const ok = await promptDialog(t('collectionNew'), name);
    const col = ok ? await createCollection(name.value) : null;
    collections = await loadCollections();
    if (col) state.collection = col.id;
    renderCollectionFilter();
  } else {
    state.collection = e.target.value;
  }
  reset();
});

let searchTimer;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = search.value; reset(); }, 200);
});

function applyListClass() {
  listEl.className = inTrash()
    ? 'items list trash-list'
    : `items ${state.view} size-${state.size}${state.selecting ? ' selecting' : ''}`;
  for (const b of document.querySelectorAll('[data-size]')) b.setAttribute('aria-pressed', String(b.dataset.size === state.size));
}

function setSize(size, persist = true) {
  state.size = SIZES.includes(size) ? size : 'm';
  applyListClass();
  if (persist) setSetting('thumbSize', state.size);
}
for (const b of document.querySelectorAll('[data-size]')) b.addEventListener('click', () => setSize(b.dataset.size));
$('trash-btn').addEventListener('click', () => selectStatus(inTrash() ? 'unread' : 'trash'));

async function setView(view, persist = true) {
  state.view = view;
  applyListClass();
  $('view-grid').setAttribute('aria-pressed', String(view === 'grid'));
  $('view-list').setAttribute('aria-pressed', String(view === 'list'));
  if (persist) await setSetting('view', view);
}
$('view-grid').addEventListener('click', () => setView('grid'));
$('view-list').addEventListener('click', () => setView('list'));

$('surprise').addEventListener('click', async () => {
  const item = await db.randomItem(filters());
  if (!item) return toast(toasts, t('surpriseNone'));
  openWeb(item);
});

// ---- selection mode and bulk actions ----
function setSelecting(on) {
  state.selecting = on;
  document.body.classList.toggle('selecting', on);
  listEl.classList.toggle('selecting', on);
  $('select-mode').setAttribute('aria-pressed', String(on));
  if (!on) {
    state.selected.clear();
    for (const c of listEl.querySelectorAll('.card.selected')) c.classList.remove('selected');
  }
  updateBulkBar();
}

function toggleSelected(card, range = false) {
  const all = cards();
  const idx = all.indexOf(card);
  const targets = range && state.lastClicked >= 0
    ? all.slice(Math.min(idx, state.lastClicked), Math.max(idx, state.lastClicked) + 1)
    : [card];
  const select = !state.selected.has(Number(card.dataset.id));
  for (const c of targets) {
    const id = Number(c.dataset.id);
    if (select) state.selected.add(id); else state.selected.delete(id);
    c.classList.toggle('selected', select);
  }
  state.lastClicked = idx;
  updateBulkBar();
}

async function updateBulkBar() {
  $('bulk-bar').hidden = !state.selecting;
  $('bulk-count').textContent = t('selectedCount', [String(state.selected.size)]);
  for (const b of document.querySelectorAll('[data-bulk]')) b.disabled = state.selected.size === 0;
  if (state.selecting) $('bulk-all').textContent = t('selectAll', [String((await db.matchingIds(filters())).length)]);
}

$('select-mode').addEventListener('click', () => setSelecting(!state.selecting));
$('bulk-cancel').addEventListener('click', () => setSelecting(false));
$('bulk-all').addEventListener('click', async () => {
  state.selected = new Set(await db.matchingIds(filters()));
  for (const c of cards()) c.classList.add('selected');
  updateBulkBar();
});

// In selection mode a click on a card selects it instead of opening it.
listEl.addEventListener('click', e => {
  if (!state.selecting) return;
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  e.stopPropagation();
  toggleSelected(card, e.shiftKey);
}, true);

async function bulk(kind) {
  const ids = [...state.selected];
  if (!ids.length) return;
  let changed = [];
  if (kind === 'archive') changed = await db.updateItems(ids, { status: 'archive' });
  if (kind === 'unread') changed = await db.updateItems(ids, { status: 'unread' });
  if (kind === 'favorite') changed = await db.updateItems(ids, { favorite: 1 });
  if (kind === 'expire') {
    const nodes = expirePicker(1);
    if (!(await promptDialog(t('expireBulkTitle', [String(ids.length)]), ...nodes))) return;
    changed = await db.updateItems(ids, { expires: expiresFrom(nodes[0].value) });
  }
  if (kind === 'tag') {
    const input = el('input', { type: 'text', list: 'tag-suggestions', placeholder: t('tagsPlaceholder') });
    if (!(await promptDialog(t('addTagsTitle', [String(ids.length)]), input))) return;
    const add = normalizeTags(input.value);
    if (!add.length) return;
    changed = await db.updateItems(ids, item => ({ tags: [...item.tags, ...add] }));
  }
  if (kind === 'collection') {
    const picker = collectionPicker('');
    if (!(await promptDialog(t('moveToCollection'), ...picker.nodes))) return;
    const col = await picker.value();
    if (col === null) return;
    changed = await db.updateItems(ids, { collection: col });
  }
  if (kind === 'delete') {
    const trashed = await db.trashItems(ids);
    const removed = trashed.removed;
    setSelecting(false);
    reset();
    toast(toasts, t('bulkDeleted', [String(removed.length)]), {
      label: t('undo'),
      run: async () => { await db.undoTrash(trashed); reset(); },
    });
    return;
  }
  toast(toasts, t('bulkDone', [String(changed.length)]));
  state.selected.clear();
  updateBulkBar();
  reset();
}
for (const b of document.querySelectorAll('[data-bulk]')) b.addEventListener('click', () => bulk(b.dataset.bulk));

// ---- keyboard ----
function setFocus(index, scroll = true) {
  const all = cards();
  all[state.focus]?.classList.remove('focused');
  state.focus = all.length ? Math.max(0, Math.min(index, all.length - 1)) : -1;
  const card = all[state.focus];
  if (!card) return;
  card.classList.add('focused');
  if (scroll) { card.focus({ preventScroll: true }); card.scrollIntoView({ block: 'nearest' }); }
  if (state.focus > all.length - 6) loadMore();
}

function columns() {
  if (listEl.classList.contains('list')) return 1;
  const all = cards();
  if (!all.length) return 1;
  const top = all[0].offsetTop;
  let n = 0;
  while (n < all.length && all[n].offsetTop === top) n++;
  return n || 1;
}

document.addEventListener('mousedown', () => document.body.classList.remove('kb-nav'), true);
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') document.body.classList.add('kb-nav');
  const typing = e.target.closest?.('input, textarea, select');
  if (typing) {
    if (e.key === 'Escape' && e.target === search) search.blur();
    if (e.key === 'ArrowDown' && e.target === search) { search.blur(); setFocus(0); e.preventDefault(); }
    return;
  }
  if ($('help-dialog').open || $('prompt').open || $('triage').open) return;
  if (inTrash() && !['/', '?'].includes(e.key)) return;
  const card = cards()[state.focus];
  const item = card?._item;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const run = fn => { e.preventDefault(); fn(); };
  switch (key) {
    case '/': return run(() => search.focus());
    case '?': return run(() => $('help-dialog').showModal());
    case 'r': return run(() => startTriage());
    case 'Escape': if (state.selecting) run(() => setSelecting(false)); return;
    case 'ArrowRight': return run(() => setFocus(state.focus + 1));
    case 'ArrowLeft': return run(() => setFocus(state.focus - 1));
    case 'ArrowDown': return run(() => setFocus(state.focus < 0 ? 0 : state.focus + columns()));
    case 'ArrowUp': return run(() => setFocus(state.focus - columns()));
    case 'Home': return run(() => setFocus(0));
    case 'End': return run(() => setFocus(cards().length - 1));
  }
  if (!item) return;
  switch (key) {
    case 'Enter': return run(() => openWeb(item));
    case 'l': return run(() => openReader(item));
    case 'a': return run(() => toggleArchive(item, card));
    case 'f': return run(() => toggleFavorite(item, card));
    case 't': return run(() => editTags(item, card));
    case 'n': return run(() => editNote(item, card));
    case 'c': return run(() => moveToCollection(item, card));
    case 'b': return run(() => scheduleDelete(item, card));
    case 'x': return run(() => { if (!state.selecting) setSelecting(true); toggleSelected(card); });
    case 'e': return run(() => emailFromList(item));
    case 'Delete': return run(() => remove(item, card));
  }
});

// ---- export / import ----
const exportBtn = $('export');
const exportMenu = $('export-menu');
function toggleExportMenu(open = exportMenu.hidden) {
  exportMenu.hidden = !open;
  exportBtn.setAttribute('aria-expanded', String(open));
  if (open) exportMenu.querySelector('button').focus();
}
exportBtn.addEventListener('click', e => { e.stopPropagation(); toggleExportMenu(); });
document.addEventListener('click', e => { if (!exportMenu.hidden && !e.target.closest('.menu-wrap')) toggleExportMenu(false); });
exportMenu.addEventListener('keydown', e => { if (e.key === 'Escape') { toggleExportMenu(false); exportBtn.focus(); } });
for (const b of exportMenu.querySelectorAll('[data-export]')) {
  b.addEventListener('click', async () => {
    toggleExportMenu(false);
    const n = await exportAs(b.dataset.export);
    if (n != null) toast(toasts, t('exportDone', [String(n)]));
  });
}

async function doImport(file) {
  $('import-hint').hidden = true;
  toast(toasts, t('importing'));
  try {
    const { added, skipped, invalid } = await importFile(file);
    toast(toasts, t('importResult', [String(added), String(skipped), String(invalid)]));
    reset();
    startBackgroundFetch();
  } catch (err) {
    console.error(err);
    toast(toasts, t('importError'));
  }
}

$('file').accept = IMPORT_ACCEPT;
const pickFile = () => { $('file').value = ''; $('file').click(); };
$('import').addEventListener('click', pickFile);
$('import-hint-btn').addEventListener('click', pickFile);
$('file').addEventListener('change', e => { if (e.target.files[0]) doImport(e.target.files[0]); });
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('data').addEventListener('click', () => openDataPage(''));

// ---- background download of text/title/thumbnail ----
// Off by default. While the user hasn't decided, a notice offers to switch it on (which asks
// for site access); "Not now" hides it for good (it can be switched on in "Data and backups").
let bgRunning = false;
async function startBackgroundFetch() {
  if (bgRunning) return;
  const pending = (await db.itemsToFetch(false)).length;
  if (!pending) return;
  const { bgFetch, bgFetchAsked } = await browser.storage.local.get(['bgFetch', 'bgFetchAsked']).catch(() => ({}));
  const permitted = await hasSitePermission();
  if (!bgFetch || !permitted) {
    const ask = (bgFetch === undefined && !bgFetchAsked) || (bgFetch === true && !permitted);
    if (ask) {
      $('bg-ask-text').textContent = t('bgFetchAsk', [String(pending)]);
      $('bg-ask').hidden = false;
    }
    return;
  }
  bgRunning = true;
  const progress = $('bg-progress');
  try {
    const result = await runBackgroundFetch({
      onProgress: async s => {
        progress.hidden = false;
        progress.textContent = t('bgFetchProgress', [String(s.done), String(s.total)]);
        const card = cardById(s.id);
        if (card && !card.querySelector('.editor')) replaceCard(card, await db.getItem(s.id));
        if (s.done % 10 === 0) refreshCounts();
      },
    });
    if (result) { refreshCounts(); refreshFacets(); }
  } finally {
    bgRunning = false;
    progress.hidden = true;
  }
}
$('bg-allow').addEventListener('click', async () => {
  // Straight from the click so Firefox shows its permission prompt.
  if (!(await browser.permissions.request(ALL_URLS).catch(() => false))) return toast(toasts, t('fetchDenied'));
  await setSetting('bgFetch', true);
  $('bg-ask').hidden = true;
  startBackgroundFetch();
});
$('bg-later').addEventListener('click', async () => {
  await browser.storage.local.set({ bgFetchAsked: true, bgFetch: false });
  $('bg-ask').hidden = true;
});

// ---- cleanup mode: go through the list one item at a time ----
// Keep / archive / delete / favorite with one key each; "Undo" goes back one step.
const triage = { ids: [], pos: 0, history: [], stats: { kept: 0, archived: 0, deleted: 0 }, item: null };

async function startTriage() {
  if (inTrash()) return;
  const ids = await db.matchingIds(filters());
  if (!ids.length) return toast(toasts, t('triageNothing'));
  // matchingIds comes oldest first; follow the list's order.
  triage.ids = state.order === 'oldest' ? ids : ids.reverse();
  triage.pos = 0;
  triage.history = [];
  triage.stats = { kept: 0, archived: 0, deleted: 0 };
  $('triage').showModal();
  showTriageItem();
}

async function showTriageItem() {
  const box = $('triage-card');
  $('triage-undo').disabled = !triage.history.length;
  // Skip items deleted meanwhile.
  while (triage.pos < triage.ids.length && !(triage.item = await db.getItem(triage.ids[triage.pos]))) triage.pos++;
  if (triage.pos >= triage.ids.length) {
    triage.item = null;
    $('triage-progress').textContent = '';
    $('triage-actions').hidden = true;
    const { kept, archived, deleted } = triage.stats;
    box.replaceChildren(el('div', { class: 'triage-done' },
      el('strong', {}, t('triageDone')),
      el('p', {}, t('triageSummary', [String(kept), String(archived), String(deleted)]))));
    return;
  }
  $('triage-actions').hidden = false;
  const item = triage.item;
  $('triage-progress').textContent = t('triageProgress', [String(triage.pos + 1), String(triage.ids.length)]);
  const minutes = readingMinutes(item.words);
  const colName = collectionName(collections, item.collection);
  box.replaceChildren(
    thumbTile(item),
    el('div', { class: 'triage-body' },
      el('a', { class: 'triage-title', dir: 'auto', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, titleOf(item)),
      el('div', { class: 'triage-meta' }, [hostOf(item.url), formatDate(item.time_added, uiLocale()), minutes ? t('minutes', [String(minutes)]) : '', colName, item.status === 'archive' ? t('filterArchive') : ''].filter(Boolean).join(' · ')),
      item.note ? el('p', { class: 'card-note' }, item.note) : null,
      item.tags?.length ? el('div', { class: 'card-tags' }, item.tags.map(tag => el('span', { class: 'tag-chip' }, tag))) : null));
  $('triage-fav').classList.toggle('on', !!item.favorite);
}

async function triageAct(kind) {
  const item = triage.item;
  if (!item) return;
  if (kind === 'keep') {
    triage.history.push({ kind, item });
    triage.stats.kept++;
  } else if (kind === 'archive') {
    await db.updateItem(item.id, { status: 'archive' });
    triage.history.push({ kind, item });
    triage.stats.archived++;
  } else if (kind === 'delete') {
    triage.history.push({ kind, item, trashed: await db.trashItems([item.id]) });
    triage.stats.deleted++;
  } else if (kind === 'favorite') {
    triage.item = await db.updateItem(item.id, { favorite: item.favorite ? 0 : 1 });
    $('triage-fav').classList.toggle('on', !!triage.item.favorite);
    return;
  }
  triage.pos++;
  showTriageItem();
}

async function triageUndo() {
  const last = triage.history.pop();
  if (!last) return;
  if (last.kind === 'archive') await db.updateItem(last.item.id, { status: last.item.status });
  if (last.kind === 'delete') await db.undoTrash(last.trashed);
  const key = { keep: 'kept', archive: 'archived', delete: 'deleted' }[last.kind];
  triage.stats[key]--;
  triage.pos = Math.max(0, triage.pos - 1);
  showTriageItem();
}

for (const b of document.querySelectorAll('[data-triage]')) b.addEventListener('click', () => triageAct(b.dataset.triage));
$('triage-undo').addEventListener('click', triageUndo);
$('triage-open').addEventListener('click', () => triage.item && openWeb(triage.item));
$('triage-reader').addEventListener('click', () => triage.item && openReader(triage.item));
$('triage-close').addEventListener('click', () => $('triage').close());
$('triage').addEventListener('close', () => { if (triage.history.length) reset(); });
$('triage').addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); triageUndo(); } return; }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const map = { ArrowRight: 'keep', k: 'keep', ' ': 'keep', a: 'archive', Delete: 'delete', d: 'delete', f: 'favorite' };
  if (map[key]) { e.preventDefault(); triageAct(map[key]); }
  else if (key === 'z' || key === 'ArrowLeft') { e.preventDefault(); triageUndo(); }
  else if (key === 'Enter' && triage.item && e.target.tagName !== 'BUTTON') { e.preventDefault(); openWeb(triage.item); }
  else if (key === 'l' && triage.item) { e.preventDefault(); openReader(triage.item); }
});
$('triage-btn').addEventListener('click', startTriage);

// ---- icons on buttons ----
$('surprise').prepend(icon('dice'));
$('triage-btn').prepend(icon('broom'));
for (const [id, name] of [['triage-undo', 'unarchive'], ['triage-open', 'external'], ['triage-reader', 'book'], ['triage-fav', 'star']]) $(id).prepend(icon(name));
for (const [kind, name] of [['keep', 'check'], ['archive', 'archive'], ['delete', 'trash']]) document.querySelector(`[data-triage="${kind}"]`).prepend(icon(name));
$('select-mode').prepend(icon('select'));
exportBtn.prepend(icon('download'));
exportBtn.append(icon('chevron'));
$('import').prepend(icon('upload'));
$('search-icon').append(icon('search'));
$('view-grid').append(icon('grid'));
$('view-list').append(icon('list'));
for (const [size, name] of [['s', 'gridSmall'], ['m', 'gridMedium'], ['l', 'gridLarge']]) document.querySelector(`[data-size="${size}"]`).append(icon(name));
$('trash-btn').prepend(icon('trash'));
$('help').append(icon('keyboard'));
$('data').append(icon('settings'));
$('tab-tags').prepend(icon('tag'));
$('tab-sites').prepend(icon('globe'));

// The popup's and the right-click menu's export/import land here with a hash.
async function handleHash() {
  const hash = location.hash;
  if (!hash) return;
  history.replaceState(null, '', location.pathname);
  if (hash === '#export') {
    const n = await exportAs('csv');
    if (n != null) toast(toasts, t('exportDone', [String(n)]));
  }
  if (hash === '#trash') selectStatus('trash');
  if (hash === '#import') {
    $('import-hint').hidden = false;
    $('import-hint-btn').focus();
  }
}
window.addEventListener('hashchange', handleHash);

// When coming back to this tab, pick up items saved meanwhile from the popup or the
// context menu, but only if the user is near the top (never yank the scroll position).
let newestSeen = null;
async function rememberNewest() { newestSeen = (await db.recent(1))[0]?.id ?? null; }
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return rememberNewest();
  refreshCounts();
  const newest = (await db.recent(1))[0]?.id ?? null;
  if (newest !== newestSeen && window.scrollY < 200 && !state.selecting) reset();
});
// Changes made in other tabs (the reader, another "View all", the popup, the background).
const sync = { ids: new Set(), all: false, timer: 0 };
browser.runtime.onMessage.addListener(message => {
  if (message?.type !== 'items-changed') return;
  if (Array.isArray(message.ids)) for (const id of message.ids) sync.ids.add(id);
  else sync.all = true;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(applySync, 250);
});
async function applySync() {
  const ids = [...sync.ids];
  const all = sync.all;
  sync.ids.clear();
  sync.all = false;
  refreshCounts();
  if (inTrash()) return reset();
  for (const id of ids) {
    const card = cardById(id);
    if (!card || card.querySelector('.editor')) continue;
    const item = await db.getItem(id);
    // Background downloads touch items often: only redraw what changed.
    if (item && JSON.stringify(item) === JSON.stringify(card._item)) continue;
    replaceCard(card, item);
  }
  if (all) refreshFacets();
}

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.collections) { collections = await loadCollections(); renderCollectionFilter(); }
});

await Promise.all([initI18n(), applyTheme()]);
applyI18n();
const settings = await getSettings();
const { listOrder = 'newest', listFacet = 'tags', thumbSize = 'm' } = await browser.storage.local.get(['listOrder', 'listFacet', 'thumbSize']).catch(() => ({}));
state.size = SIZES.includes(thumbSize) ? thumbSize : 'm';
state.order = listOrder === 'oldest' ? 'oldest' : 'newest';
state.facet = listFacet === 'sites' ? 'sites' : 'tags';
$('order').value = state.order;
collections = await loadCollections();
renderCollectionFilter();
setView(settings.view, false);
// Cleanup first, so what's due doesn't show up for a moment and then vanish.
const cleaned = await runCleanup().catch(err => { console.warn(err); return { trashed: 0 }; });
selectStatus('unread');
handleHash();
if (cleaned.trashed) toast(toasts, t('cleanupDone', [String(cleaned.trashed)]), { label: t('openTrash'), run: () => selectStatus('trash') });
backfillWordCounts().then(n => { if (n) reset(); }).then(backfillTexts).finally(startBackgroundFetch);
