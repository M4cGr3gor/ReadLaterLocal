import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LANGUAGES, DEFAULT_LANGUAGE, resolveLanguage } from '../src/lib/i18n.js';

const dir = new URL('../src/_locales/', import.meta.url);
const load = lang => JSON.parse(readFileSync(new URL(`${lang}/messages.json`, dir), 'utf8'));
const en = load('en');
const tokens = s => (s.match(/\$[A-Z_]+\$|\{file\}/g) || []).sort();
// key_one, key_few…: optional singular/plural forms of an existing message.
const FORMS = ['_zero', '_one', '_two', '_few', '_many'];
const baseOf = key => {
  const form = FORMS.find(f => key.endsWith(f) && key.slice(0, -f.length) in en);
  return form ? key.slice(0, -form.length) : null;
};
const baseKeys = m => Object.keys(m).filter(k => !baseOf(k)).sort();

test('every locale folder is offered, and every offered language has a folder', () => {
  const folders = readdirSync(dir).sort();
  assert.deepEqual(folders, [...LANGUAGES].sort());
  assert.equal(DEFAULT_LANGUAGE, 'en');
});

for (const lang of LANGUAGES) {
  test(`${lang}: same keys, placeholders and tokens as English, nothing empty`, () => {
    const m = load(lang);
    assert.deepEqual(baseKeys(m), baseKeys(en));
    for (const [key, entry] of Object.entries(m)) {
      const base = baseOf(key);
      if (!base) continue;
      assert.ok(entry.message.trim(), `${lang} ${key} is empty`);
      assert.deepEqual(tokens(entry.message), tokens(en[base].message), `${lang} ${key} (form of ${base})`);
      assert.deepEqual(entry.placeholders, en[base].placeholders, `${lang} ${key} placeholders`);
    }
    for (const [key, entry] of Object.entries(en)) {
      if (baseOf(key)) continue;
      assert.ok(m[key].message.trim(), `${lang} ${key} is empty`);
      assert.deepEqual(tokens(m[key].message), tokens(entry.message), `${lang} ${key}`);
      assert.deepEqual(m[key].placeholders, entry.placeholders, `${lang} ${key} placeholders`);
    }
  });
}

test('the browser language picks the extension language, English when there is none', () => {
  assert.equal(resolveLanguage('es-ES'), 'es');
  assert.equal(resolveLanguage('es-419'), 'es');
  assert.equal(resolveLanguage('de'), 'de');
  assert.equal(resolveLanguage('pt-BR'), 'pt_BR');
  assert.equal(resolveLanguage('pt-PT'), 'pt_BR');
  assert.equal(resolveLanguage('zh-CN'), 'zh_CN');
  assert.equal(resolveLanguage('zh-SG'), 'zh_CN');
  assert.equal(resolveLanguage('zh-TW'), 'zh_TW');
  assert.equal(resolveLanguage('zh-HK'), 'zh_TW');
  assert.equal(resolveLanguage('zh-Hant'), 'zh_TW');
  assert.equal(resolveLanguage('ar-EG'), 'ar');
  assert.equal(resolveLanguage('en-GB'), 'en');
  assert.equal(resolveLanguage('nl'), 'en');
  assert.equal(resolveLanguage('sv-SE'), 'en');
  assert.equal(resolveLanguage(''), 'en');
  assert.equal(resolveLanguage(undefined), 'en');
});

test('counts use the singular form when the language has one', async () => {
  const { initI18n, t } = await import('../src/lib/i18n.js');
  let language = 'es';
  globalThis.browser = {
    storage: { local: { get: async () => ({ language }) } },
    i18n: { getUILanguage: () => 'es', getMessage: () => '' },
    runtime: { getURL: p => p },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async p => ({ json: async () => JSON.parse(readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')) });
  try {
    await initI18n();
    assert.equal(t('itemCount', ['1']), '1 registro');
    assert.equal(t('itemCount', ['5']), '5 registros');
    assert.equal(t('itemCount', ['1.234']), '1.234 registros', 'a formatted thousand is plural');
    assert.equal(t('trashDaysLeft', ['1']), 'se borra en 1 día');
    assert.equal(t('triageProgress', ['1', '9']), '1 de 9', 'messages without a singular form stay as they are');
    language = 'en';
    await initI18n();
    assert.equal(t('bulkDeleted', ['1']), '1 item moved to the trash');
    assert.equal(t('bulkDeleted', ['0']), '0 items moved to the trash');
    language = 'fr';
    await initI18n();
    assert.equal(t('itemCount', ['0']), '0 élément', 'French uses the singular for 0 too');
    language = 'ar';
    await initI18n();
    assert.equal(t('bulkDone', ['3']), 'العناصر المحدَّثة: 3', 'Arabic: label and number, right for any count');
  } finally {
    delete globalThis.browser;
    globalThis.fetch = realFetch;
  }
});
