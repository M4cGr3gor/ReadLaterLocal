// "Data and backups": storage use, automatic backups, export/import, article download, wipe.
import * as db from '../lib/db.js';
import { applyTheme, saveTheme } from '../lib/theme.js';
import { applyI18n, initI18n, t, uiLocale, LANGUAGES, LANGUAGE_NAMES } from '../lib/i18n.js';
import { exportAs, importFile, IMPORT_ACCEPT } from '../lib/transfer.js';
import { getSettings, setSetting } from '../lib/settings.js';
import { runBackup } from '../lib/autobackup.js';
import { fetchAll, hasSitePermission, ALL_URLS } from '../lib/fetcher.js';
import { runBackgroundFetch } from '../lib/bgfetch.js';
import { loadCollections, createCollection, renameCollection, deleteCollection } from '../lib/collections.js';
import { applyRules, loadRules, saveRules, normalizeSite, ruleValueError } from '../lib/rules.js';
import { cleanupMatches, isComplete, loadCleanupRules, newCleanupRule, runCleanup, saveCleanupRules } from '../lib/cleanup.js';
import { iconStyle } from '../lib/icons.js';
import { normalizeTags } from '../lib/util.js';
import { el, formatBytes, icon, toast } from '../lib/ui.js';

const $ = id => document.getElementById(id);
const toasts = $('toasts');
await Promise.all([initI18n(), applyTheme()]);
const locale = uiLocale();
const num = n => n.toLocaleString(locale);

// ---- storage ----
async function refreshStats() {
  const s = await db.storageStats();
  $('st-items').textContent = num(s.items);
  $('st-articles').textContent = num(s.articles);
  $('st-articles-b').textContent = formatBytes(s.articleBytes, locale);
  $('st-thumbs').textContent = num(s.thumbs);
  $('st-thumbs-b').textContent = formatBytes(s.thumbBytes, locale);
  $('st-favicons').textContent = num(s.favicons);
  $('st-favicons-b').textContent = formatBytes(s.faviconBytes, locale);
  $('st-images').textContent = num(s.images);
  $('st-images-b').textContent = formatBytes(s.imageBytes, locale);
  $('st-texts').textContent = num(s.texts);
  $('st-texts-b').textContent = formatBytes(s.textBytes, locale);
  $('images-usage').textContent = t('imagesUsage', [num(s.images), formatBytes(s.imageBytes, locale)]);
  $('images-clear').disabled = !s.images;
  // Item records are small (~300 bytes each); add them to the blob sizes for an estimate.
  $('st-total').textContent = formatBytes(s.articleBytes + s.thumbBytes + s.faviconBytes + s.imageBytes + s.textBytes + s.items * 300, locale);
}

$('free').addEventListener('click', async () => {
  const n = await db.deleteArchivedArticles();
  toast(toasts, t('freedArticles', [String(n)]));
  refreshStats();
});

// ---- automatic backups ----
async function refreshBackup() {
  const { backup } = await getSettings();
  $('bk-enabled').checked = backup.enabled;
  $('bk-frequency').value = backup.frequency;
  $('bk-keep').value = backup.keep;
  $('bk-last').textContent = backup.lastRun
    ? t('backupLast', [new Date(backup.lastRun).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })])
    : t('backupNever');
}

async function updateBackup(patch) {
  const { backup } = await getSettings();
  await setSetting('backup', { ...backup, ...patch });
  refreshBackup();
}

$('bk-enabled').addEventListener('change', e => updateBackup({ enabled: e.target.checked }));
$('bk-frequency').addEventListener('change', e => updateBackup({ frequency: e.target.value }));
$('bk-keep').addEventListener('change', e => updateBackup({ keep: Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 3))) }));
$('bk-now').addEventListener('click', async () => {
  try {
    const { filename } = await runBackup();
    toast(toasts, t('backupDone', [filename]));
  } catch (err) {
    console.error(err);
    toast(toasts, t('backupFailed'));
  }
  refreshBackup();
});

// ---- export / import ----
for (const b of document.querySelectorAll('[data-export]')) {
  b.addEventListener('click', async () => {
    const n = await exportAs(b.dataset.export, { images: $('export-images').checked });
    if (n != null) toast(toasts, t('exportDone', [String(n)]));
  });
}
$('file').accept = IMPORT_ACCEPT;
$('import').addEventListener('click', () => { $('file').value = ''; $('file').click(); });
$('file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  toast(toasts, t('importing'));
  try {
    const { added, skipped, invalid } = await importFile(file);
    toast(toasts, t('importResult', [String(added), String(skipped), String(invalid)]));
  } catch (err) {
    console.error(err);
    toast(toasts, t('importError'));
  }
  refreshStats();
  refreshPending();
});

// ---- article download for imported items ----
let controller = null;

async function refreshPending() {
  const n = (await db.itemsToFetch($('fetch-retry').checked)).length;
  $('fetch-pending').textContent = t('fetchPending', [num(n)]);
  $('revoke').hidden = !(await hasSitePermission());
  const broken = (await db.itemsWithBrokenText()).length;
  $('repair-box').hidden = !broken;
  $('repair-text').textContent = t('repairPending', [num(broken)]);
}

// Articles downloaded before v1.6.1 with the wrong character set ("�" instead of accents).
$('repair').addEventListener('click', async () => {
  if (!(await browser.permissions.request(ALL_URLS).catch(() => false))) return toast(toasts, t('fetchDenied'));
  const items = await db.itemsWithBrokenText();
  $('repair').disabled = true;
  const stats = await fetchAll(items, {
    signal: new AbortController().signal,
    onProgress: s => { $('repair-text').textContent = t('repairProgress', [num(s.done), num(s.total)]); },
  });
  $('repair').disabled = false;
  toast(toasts, t('repairDone', [num(stats.ok)]));
  refreshStats();
  refreshPending();
});
$('fetch-retry').addEventListener('change', refreshPending);

function showProgress(s) {
  $('fetch-bar').max = Math.max(1, s.total);
  $('fetch-bar').value = s.done;
  $('fetch-text').textContent = t('fetchProgress', [num(s.done), num(s.total), num(s.ok), num(s.partial), num(s.failed)]);
}

$('fetch-start').addEventListener('click', async () => {
  // Must be called straight from the click so Firefox shows its permission prompt.
  const granted = await browser.permissions.request(ALL_URLS);
  if (!granted) { toast(toasts, t('fetchDenied')); return; }
  const items = await db.itemsToFetch($('fetch-retry').checked);
  controller = new AbortController();
  $('fetch-start').hidden = true;
  $('fetch-cancel').hidden = false;
  $('fetch-progress').hidden = false;
  showProgress({ done: 0, total: items.length, ok: 0, partial: 0, failed: 0 });
  let lastStats = 0;
  await fetchAll(items, {
    signal: controller.signal,
    onProgress: s => {
      showProgress(s);
      if (Date.now() - lastStats > 3000) { lastStats = Date.now(); refreshStats(); }
    },
  });
  controller = null;
  $('fetch-start').hidden = false;
  $('fetch-cancel').hidden = true;
  $('fetch-text').textContent += ' · ' + t('fetchFinished');
  refreshStats();
  refreshPending();
});
$('fetch-cancel').addEventListener('click', () => controller?.abort());
$('revoke').addEventListener('click', async () => {
  await browser.permissions.remove(ALL_URLS);
  await setSetting('bgFetch', false);
  await setSetting('offlineImages', false);
  $('bg-fetch').checked = false;
  $('offline-images').checked = false;
  toast(toasts, t('permissionRevoked'));
  refreshPending();
});

// ---- wipe ----
$('wipe').addEventListener('click', async () => {
  const { all } = await db.counts();
  if (!(await confirmDialog(t('confirmDeleteAll', [num(all)]), t('deleteAll')))) return;
  await db.clearAll();
  toast(toasts, t('allDeleted'));
  refreshStats();
  refreshPending();
});

// ---- language ----
const { language = 'auto' } = await browser.storage.local.get('language').catch(() => ({}));
// Each language under its own name, so anyone can find theirs.
$('language').append(...Object.entries(LANGUAGE_NAMES).map(([code, name]) =>
  el('option', { value: code, lang: code.replace('_', '-'), dir: code === 'ar' ? 'rtl' : 'ltr' }, name)));
$('language').value = LANGUAGES.includes(language) ? language : 'auto';
$('language').addEventListener('change', async e => {
  // Every open page of the extension (this one too) reloads itself in the new language.
  await setSetting('language', e.target.value);
});

// ---- appearance: theme and unread counter ----
const prefs = await browser.storage.local.get(['theme', 'reader', 'badge', 'bgFetch', 'offlineImages']).catch(() => ({}));
$('theme').value = prefs.theme || prefs.reader?.theme || 'system';
$('theme').addEventListener('change', e => saveTheme(e.target.value));
$('badge').checked = prefs.badge !== false;
$('badge').addEventListener('change', e => setSetting('badge', e.target.checked));
const currentIconStyle = await iconStyle();
for (const r of document.querySelectorAll('input[name="icon-style"]')) {
  r.checked = r.value === currentIconStyle;
  r.addEventListener('change', () => { if (r.checked) setSetting('iconStyle', r.value); });
}

// ---- background download (off by default; switching it on asks for site access) ----
$('bg-fetch').checked = prefs.bgFetch === true && (await hasSitePermission());
$('bg-fetch').addEventListener('change', async e => {
  if (!e.target.checked) {
    await setSetting('bgFetch', false);
    return;
  }
  // Must be requested straight from the click so Firefox shows its prompt.
  const granted = await browser.permissions.request(ALL_URLS).catch(() => false);
  if (!granted) {
    e.target.checked = false;
    toast(toasts, t('fetchDenied'));
    return;
  }
  await setSetting('bgFetch', true);
  refreshPending();
  startBackgroundFetch();
});

async function startBackgroundFetch() {
  const result = await runBackgroundFetch({ onProgress: s => { if (s.done % 10 === 0) { refreshStats(); refreshPending(); } } });
  if (result) { refreshStats(); refreshPending(); }
}

// ---- offline pictures (off by default; switching on asks for site access) ----
$('offline-images').checked = prefs.offlineImages === true && (await hasSitePermission());
$('offline-images').addEventListener('change', async e => {
  if (!e.target.checked) return setSetting('offlineImages', false);
  const granted = await browser.permissions.request(ALL_URLS).catch(() => false);
  if (!granted) {
    e.target.checked = false;
    toast(toasts, t('fetchDenied'));
    return;
  }
  await setSetting('offlineImages', true);
  toast(toasts, t('imagesEnabledToast'));
});
$('images-clear').addEventListener('click', async () => {
  if (!(await confirmDialog(t('imagesClearConfirm'), t('imagesClear')))) return;
  await db.deleteAllImages();
  toast(toasts, t('imagesCleared'));
  refreshStats();
});

// ---- collections ----
async function renderCollections() {
  const list = await loadCollections();
  const counts = new Map();
  for (const item of await db.allItems()) if (item.collection) counts.set(item.collection, (counts.get(item.collection) || 0) + 1);
  $('collections').replaceChildren(...(list.length ? list.map(c => {
    const name = el('input', { type: 'text', value: c.name, maxlength: '60', 'aria-label': t('rename') });
    name.addEventListener('change', () => renameCollection(c.id, name.value));
    return el('li', {},
      el('span', { class: 'name' }, name),
      el('span', { class: 'count' }, t('itemCount', [num(counts.get(c.id) || 0)])),
      el('button', { class: 'btn danger', type: 'button', onclick: async () => {
        await deleteCollection(c.id);
        toast(toasts, t('collectionDeleted'));
        renderCollections();
        renderRules();
        renderCleanup();
      } }, t('delete')));
  }) : [el('li', { class: 'empty-note' }, t('collectionsEmpty'))]));
}
$('add-collection').addEventListener('click', async () => {
  if (await createCollection($('new-collection').value)) {
    $('new-collection').value = '';
    renderCollections();
    renderRules();
    renderCleanup();
  }
});
$('new-collection').addEventListener('keydown', e => { if (e.key === 'Enter') $('add-collection').click(); });

// ---- automatic rules ----
let rules = [];
async function persistRules() { await saveRules(rules); }

// One rule or cleanup row: the settings on the left, the delete button in its own box on the right.
function ruleRow(lines, onDelete) {
  return el('li', { class: 'rule' },
    el('div', { class: 'rule-main' }, ...lines),
    el('div', { class: 'rule-del' },
      el('button', { class: 'icon-btn danger', type: 'button', title: t('delete'), 'aria-label': t('delete'), onclick: onDelete }, icon('trash'))));
}

const line = (...kids) => el('div', { class: 'rule-line' }, ...kids);
const word = text => el('span', { class: 'word' }, text);

// Shows (or clears) the validation message under a value field. Returns true when valid.
function validate(input, errorEl, field) {
  const key = ruleValueError(field, input.value);
  input.setAttribute('aria-invalid', String(!!key));
  errorEl.textContent = key ? t(key) : '';
  errorEl.hidden = !key;
  return !key;
}

function siteValueInput(initial, field, onValid) {
  const input = el('input', { type: 'text', class: 'value-input', value: initial || '', spellcheck: 'false' });
  const error = el('small', { class: 'field-error', role: 'alert', hidden: true });
  const placeholder = () => {
    const f = field();
    input.placeholder = f === 'site' ? 'youtube.com' : f === 'url' ? '/blog/' : t('ruleTitlePlaceholder');
    input.setAttribute('aria-label', t(f === 'site' ? 'ruleFieldSite' : f === 'url' ? 'ruleFieldUrl' : 'ruleFieldTitle'));
  };
  placeholder();
  const commit = () => {
    const f = field();
    if (f === 'site' && normalizeSite(input.value)) input.value = normalizeSite(input.value);
    if (validate(input, error, f)) onValid(input.value.trim());
  };
  input.addEventListener('change', commit);
  input.addEventListener('input', () => { if (input.getAttribute('aria-invalid') === 'true') validate(input, error, field()); });
  return { input, error, placeholder, commit, check: () => (input.value ? validate(input, error, field()) : true) };
}

async function renderRules() {
  rules = await loadRules();
  const cols = await loadCollections();
  $('rules').replaceChildren(...(rules.length ? rules.map((rule, i) => {
    const save = patch => { rules[i] = { ...rules[i], ...patch }; persistRules(); };
    const field = el('select', { 'aria-label': t('ruleIf') },
      el('option', { value: 'site' }, t('ruleFieldSite')),
      el('option', { value: 'url' }, t('ruleFieldUrl')),
      el('option', { value: 'title' }, t('ruleFieldTitle')));
    field.value = rule.field;
    const value = siteValueInput(rule.value, () => field.value, v => save({ value: v }));
    field.addEventListener('change', () => { save({ field: field.value }); value.placeholder(); value.check(); });
    const tags = el('input', { type: 'text', class: 'tags-input', value: (rule.tags || []).join(', '), placeholder: t('tagsPlaceholder'), 'aria-label': t('ruleAddTags') });
    tags.addEventListener('change', () => save({ tags: normalizeTags(tags.value) }));
    const col = el('select', { 'aria-label': t('ruleCollection') },
      el('option', { value: '' }, t('collectionNone')),
      ...cols.map(c => el('option', { value: c.id }, c.name)));
    col.value = cols.some(c => c.id === rule.collection) ? rule.collection : '';
    col.addEventListener('change', () => save({ collection: col.value }));
    const fav = el('input', { type: 'checkbox' });
    fav.checked = !!rule.favorite;
    fav.addEventListener('change', () => save({ favorite: fav.checked }));
    if (rule.value) value.check();
    return ruleRow([
      line(word(t('ruleIf')), field, value.input, word(t('ruleThen')), word(t('ruleAddTags')), tags),
      value.error,
      line(el('label', { class: 'word' }, t('ruleCollection'), ' ', col)),
      line(el('label', { class: 'word' }, fav, ' ', t('ruleFavorite'))),
    ], async () => {
      rules.splice(i, 1);
      await persistRules();
      renderRules();
    });
  }) : [el('li', { class: 'empty-note' }, t('rulesEmpty'))]));
}
$('add-rule').addEventListener('click', async () => {
  rules = await loadRules();
  rules.push({ id: 'r' + Date.now().toString(36), field: 'site', value: '', tags: [], collection: '', favorite: false });
  await persistRules();
  await renderRules();
  $('rules').lastElementChild.querySelector('.value-input').focus();
});
$('apply-rules').addEventListener('click', async () => {
  const items = await db.allItems();
  const ids = [];
  for (const item of items) {
    const out = applyRules(item, rules);
    if (out.tags.length !== item.tags.length || out.collection !== item.collection || out.favorite !== item.favorite) ids.push(item.id);
  }
  await db.updateItems(ids, item => applyRules(item, rules));
  toast(toasts, t('rulesApplied', [num(ids.length)]));
  renderCollections();
});

// ---- automatic cleanup ----
let cleanupRules = [];
let allItemsCache = null;
const persistCleanup = () => saveCleanupRules(cleanupRules);

async function renderCleanup() {
  cleanupRules = await loadCleanupRules();
  allItemsCache = await db.allItems();
  const cols = await loadCollections();
  const { allTags } = await db.tagStats();
  $('cleanup').replaceChildren(...(cleanupRules.length ? cleanupRules.map((rule, i) => {
    const affected = el('span', { class: 'help small' });
    const controls = [];
    const updateAffected = () => {
      const r = cleanupRules[i];
      const n = isComplete(r) ? allItemsCache.filter(item => cleanupMatches(r, item)).length : 0;
      affected.textContent = isComplete(r) ? t(r.active ? 'cleanupAffectsActive' : 'cleanupAffects', [num(n)]) : t('cleanupIncomplete');
      for (const c of controls) c.disabled = !!r.active;
    };
    const save = patch => { cleanupRules[i] = { ...cleanupRules[i], ...patch }; persistCleanup(); updateAffected(); };

    const scope = el('select', { 'aria-label': t('cleanupScope') },
      el('option', { value: 'collection' }, t('cleanupScopeCollection')),
      el('option', { value: 'tag' }, t('cleanupScopeTag')),
      el('option', { value: 'site' }, t('cleanupScopeSite')),
      el('option', { value: 'all' }, t('cleanupScopeAll')));
    scope.value = rule.scope;
    const colSel = el('select', { 'aria-label': t('cleanupScopeCollection') },
      el('option', { value: '' }, t('chooseCollection')), ...cols.map(c => el('option', { value: c.id }, c.name)));
    const tagInput = el('input', { type: 'text', class: 'value-input', list: 'cleanup-tags', placeholder: t('cleanupTagPlaceholder'), 'aria-label': t('cleanupScopeTag') });
    const site = siteValueInput(rule.scope === 'site' ? rule.value : '', () => 'site', v => save({ value: v }));
    const showValue = () => {
      colSel.hidden = scope.value !== 'collection';
      tagInput.hidden = scope.value !== 'tag';
      site.input.hidden = scope.value !== 'site';
      if (scope.value !== 'site') site.error.hidden = true;
    };
    if (rule.scope === 'collection') colSel.value = cols.some(c => c.id === rule.value) ? rule.value : '';
    if (rule.scope === 'tag') tagInput.value = rule.value;
    scope.addEventListener('change', () => { save({ scope: scope.value, value: '' }); colSel.value = ''; tagInput.value = ''; site.input.value = ''; showValue(); });
    colSel.addEventListener('change', () => save({ value: colSel.value }));
    tagInput.addEventListener('change', () => save({ value: normalizeTags(tagInput.value)[0] || '' }));
    showValue();

    const status = el('select', { 'aria-label': t('cleanupStatus') },
      el('option', { value: 'any' }, t('cleanupStatusAny')),
      el('option', { value: 'unread' }, t('cleanupStatusUnread')),
      el('option', { value: 'archive' }, t('cleanupStatusArchive')));
    status.value = rule.status;
    status.addEventListener('change', () => save({ status: status.value }));
    const amount = el('input', { type: 'number', min: '1', max: '999', step: '1', value: String(rule.amount), 'aria-label': t('cleanupAmount') });
    amount.addEventListener('change', () => {
      const n = Math.max(1, Math.min(999, Math.round(Number(amount.value) || 1)));
      amount.value = String(n);
      unitLabels();
      save({ amount: n });
    });
    const unit = el('select', { 'aria-label': t('cleanupUnit') },
      ...['day', 'week', 'month', 'year'].map(u => el('option', { value: u })));
    const unitLabels = () => { for (const o of unit.options) o.textContent = t('unit_' + o.value + (Number(amount.value) === 1 ? '1' : '')); };
    unitLabels();
    amount.addEventListener('input', unitLabels);
    unit.value = rule.unit;
    unit.addEventListener('change', () => save({ unit: unit.value }));

    const active = el('input', { type: 'checkbox' });
    active.checked = !!rule.active;
    active.addEventListener('change', async () => {
      const r = { ...cleanupRules[i], active: active.checked };
      if (active.checked) {
        if (!isComplete(r)) { active.checked = false; toast(toasts, t('cleanupIncomplete')); return; }
        const n = allItemsCache.filter(item => cleanupMatches(r, item)).length;
        if (n && !(await confirmDialog(t('cleanupConfirm', [num(n)]), t('cleanupActivate')))) { active.checked = false; return; }
        save({ active: true });
        const { trashed } = await runCleanup();
        allItemsCache = await db.allItems();
        updateAffected();
        if (trashed) toast(toasts, t('cleanupDone', [num(trashed)]));
        refreshStats();
        renderCollections();
      } else {
        save({ active: false });
      }
    });
    controls.push(scope, colSel, tagInput, site.input, status, amount, unit);
    updateAffected();
    return ruleRow([
      line(word(t('cleanupMove')), scope, colSel, tagInput, site.input),
      site.error,
      line(status, word(t('cleanupOlderThan')), amount, unit, word(t('cleanupAgo'))),
      line(el('label', { class: 'word strong' }, active, ' ', t('cleanupActive')), affected),
    ], async () => {
      cleanupRules.splice(i, 1);
      await persistCleanup();
      renderCleanup();
    });
  }) : [el('li', { class: 'empty-note' }, t('cleanupEmpty'))]));
  const dl = $('cleanup-tags') || document.body.appendChild(el('datalist', { id: 'cleanup-tags' }));
  dl.replaceChildren(...allTags.map(tag => el('option', { value: tag })));
}

$('add-cleanup').addEventListener('click', async () => {
  cleanupRules = await loadCleanupRules();
  cleanupRules.push(newCleanupRule());
  await persistCleanup();
  await renderCleanup();
  $('cleanup').lastElementChild.querySelector('select').focus();
});
$('run-cleanup').addEventListener('click', async () => {
  const { trashed, purged } = await runCleanup();
  toast(toasts, t('cleanupRan', [num(trashed), num(purged)]));
  refreshStats();
  renderCollections();
  renderCleanup();
});

function confirmDialog(text, okLabel) {
  const dlg = $('confirm');
  $('confirm-text').textContent = text;
  const ok = dlg.querySelector('button[value="ok"]');
  ok.textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => {
    ok.textContent = t('deleteAll');
    resolve(dlg.returnValue === 'ok');
  }, { once: true }));
}

window.addEventListener('beforeunload', e => { if (controller) e.preventDefault(); });

applyI18n();
refreshStats();
refreshBackup();
refreshPending();
renderCollections();
renderRules();
runCleanup().catch(console.warn).finally(() => { renderCleanup(); refreshStats(); });
startBackgroundFetch();
