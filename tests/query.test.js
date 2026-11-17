import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTags, parseQuery, matchesQuery } from '../src/lib/util.js';

test('normalizeTags splits on comma and pipe, trims, lowercases, dedupes', () => {
  assert.deepEqual(normalizeTags('Linux, CSS|css , ,  Ryzen 9 '), ['linux', 'css', 'ryzen 9']);
  assert.deepEqual(normalizeTags(['A', 'a', ' b ']), ['a', 'b']);
  assert.deepEqual(normalizeTags(''), []);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('normalizeTags caps tag length at 40 chars', () => {
  assert.equal(normalizeTags('x'.repeat(60))[0].length, 40);
});

test('parseQuery extracts tag: tokens and normalizes free text', () => {
  assert.deepEqual(parseQuery('  Guía tag:CSS flexbox tag:web '), { text: 'guia flexbox', tags: ['css', 'web'], sites: [] });
  assert.deepEqual(parseQuery(''), { text: '', tags: [], sites: [] });
});

test('matchesQuery checks all tags and the text against title and url', () => {
  const item = { title: 'Guía de Flexbox', url: 'https://css-tricks.com/x', tags: ['css', 'web'] };
  assert.equal(matchesQuery(item, parseQuery('flexbox')), true);
  assert.equal(matchesQuery(item, parseQuery('css-tricks')), true);
  assert.equal(matchesQuery(item, parseQuery('tag:css')), true);
  assert.equal(matchesQuery(item, parseQuery('tag:css tag:linux')), false);
  assert.equal(matchesQuery(item, parseQuery('tag:web guia')), true);
  assert.equal(matchesQuery({ ...item, tags: undefined }, parseQuery('tag:css')), false);
});
