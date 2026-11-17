// Translations. Firefox picks _locales/<lang> from its own UI language and offers no API
// to override it, so the extension loads the chosen messages.json itself. "Automatic" uses
// Firefox's language when the extension has it (or the same language for another country),
// and English otherwise.

/** Extension languages: folder in _locales → name in that language. */
export const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  pt_BR: 'Português (Brasil)',
  pl: 'Polski',
  tr: 'Türkçe',
  id: 'Bahasa Indonesia',
  ru: 'Русский',
  ar: 'العربية',
  hi: 'हिन्दी',
  ja: '日本語',
  zh_CN: '简体中文',
  zh_TW: '繁體中文',
};
export const LANGUAGES = Object.keys(LANGUAGE_NAMES);
export const DEFAULT_LANGUAGE = 'en';
const RTL = new Set(['ar']);

let messages = null;
let active = DEFAULT_LANGUAGE;

/**
 * The extension language for a browser language tag ("pt-PT", "zh-Hant-HK", "de"…):
 * exact match, then the same language, then English.
 */
export function resolveLanguage(tag) {
  const parts = String(tag || '').replace(/_/g, '-').split('-').filter(Boolean);
  const base = (parts[0] || '').toLowerCase();
  const rest = parts.slice(1).map(p => p.toUpperCase());
  if (base === 'zh') {
    // Traditional script: Taiwan, Hong Kong, Macao or an explicit "Hant".
    return rest.some(p => ['TW', 'HK', 'MO', 'HANT'].includes(p)) ? 'zh_TW' : 'zh_CN';
  }
  const exact = rest[0] ? `${base}_${rest[0]}` : base;
  if (LANGUAGES.includes(exact)) return exact;
  if (LANGUAGES.includes(base)) return base;
  const sameLanguage = LANGUAGES.find(l => l.split('_')[0] === base);
  return sameLanguage || DEFAULT_LANGUAGE;
}

// Call once (await) before using t() on a page or in the background.
export async function initI18n() {
  const { language = 'auto' } = await browser.storage.local.get('language').catch(() => ({}));
  active = LANGUAGES.includes(language) ? language : resolveLanguage(browser.i18n.getUILanguage());
  messages = null;
  pluralRules = null;
  try {
    messages = await (await fetch(browser.runtime.getURL(`_locales/${active}/messages.json`))).json();
  } catch {
    messages = null;
  }
  return LANGUAGES.includes(language) ? language : 'auto';
}

function format(entry, subs = []) {
  const list = Array.isArray(subs) ? subs : [subs];
  let text = entry.message;
  for (const [name, ph] of Object.entries(entry.placeholders || {})) {
    const n = Number(String(ph.content).replace('$', '')) - 1;
    text = text.replace(new RegExp(`\\$${name}\\$`, 'gi'), list[n] ?? '');
  }
  return text;
}

// Singular and plural: when the first value is a number and the language has a form for it
// (key_one, key_two, key_few…, by Intl.PluralRules), that form is used: "1 item", "5 items".
const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many']);
let pluralRules = null;
function countOf(subs) {
  const first = Array.isArray(subs) ? subs[0] : subs;
  if (typeof first === 'number') return first;
  if (typeof first !== 'string' || !/^\d[\d\s.,  ]*$/.test(first)) return null;
  return Number(first.replace(/\D/g, ''));
}

export function t(key, subs) {
  if (messages?.[key]) {
    const n = countOf(subs);
    if (n !== null) {
      pluralRules ??= new Intl.PluralRules(uiLocale());
      const form = pluralRules.select(n);
      if (PLURAL_FORMS.has(form) && messages[`${key}_${form}`]) return format(messages[`${key}_${form}`], subs);
    }
    return format(messages[key], subs);
  }
  return browser.i18n.getMessage(key, subs) || key;
}

/** BCP 47 tag of the language in use, for dates and numbers ("pt-BR", "zh-TW"…). */
export function uiLocale() {
  return active.replace('_', '-');
}

/** Text direction of the language in use. */
export function textDirection() {
  return RTL.has(active) ? 'rtl' : 'ltr';
}

// Pages already open when the language changes are reloaded, so they show the new one.
let watching = false;
function watchLanguage() {
  if (watching) return;
  watching = true;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.language) location.reload();
  });
}

export function applyI18n(root = document) {
  watchLanguage();
  document.documentElement.lang = uiLocale();
  document.documentElement.dir = textDirection();
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  }
}
