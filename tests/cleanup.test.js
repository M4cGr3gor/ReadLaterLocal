import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupMatches, dueIds, isComplete, daysLeft, UNIT_SECONDS } from '../src/lib/cleanup.js';
import { normalizeSite, ruleValueError } from '../src/lib/rules.js';

const NOW = 1_000_000_000;
const DAY = 86400;
const item = (extra = {}) => ({ id: 1, url: 'https://www.youtube.com/watch?v=x', title: 'T', time_added: NOW - 40 * DAY, status: 'unread', tags: ['vídeos'], collection: 'c1', expires: 0, ...extra });
const rule = (extra = {}) => ({ active: true, scope: 'collection', value: 'c1', status: 'any', amount: 1, unit: 'month', ...extra });

test('a cleanup rule needs a target and an age', () => {
  assert.equal(isComplete(rule()), true);
  assert.equal(isComplete(rule({ value: '' })), false);
  assert.equal(isComplete(rule({ scope: 'all', value: '' })), true);
  assert.equal(isComplete(rule({ amount: 0 })), false);
  assert.equal(isComplete(rule({ unit: 'decade' })), false);
});

test('cleanup rules match by collection, tag, site, status and age since saving', () => {
  assert.equal(cleanupMatches(rule(), item(), NOW), true);
  assert.equal(cleanupMatches(rule({ value: 'c2' }), item(), NOW), false);
  assert.equal(cleanupMatches(rule({ amount: 2 }), item(), NOW), false, '40 days is not older than 2 months');
  assert.equal(cleanupMatches(rule({ scope: 'tag', value: 'Vídeos' }), item(), NOW), true);
  assert.equal(cleanupMatches(rule({ scope: 'tag', value: 'videos' }), item(), NOW), false);
  assert.equal(cleanupMatches(rule({ scope: 'site', value: 'youtube.com' }), item(), NOW), true);
  assert.equal(cleanupMatches(rule({ scope: 'site', value: 'tube.com' }), item(), NOW), false);
  assert.equal(cleanupMatches(rule({ scope: 'all', value: '' }), item(), NOW), true);
  assert.equal(cleanupMatches(rule({ status: 'archive' }), item(), NOW), false);
  assert.equal(cleanupMatches(rule({ status: 'archive' }), item({ status: 'archive' }), NOW), true);
  assert.equal(cleanupMatches(rule({ status: 'unread' }), item({ status: 'archive' }), NOW), false);
  assert.equal(cleanupMatches(rule({ unit: 'year' }), item(), NOW), false);
  assert.equal(cleanupMatches(rule({ unit: 'week', amount: 5 }), item(), NOW), true);
  assert.equal(UNIT_SECONDS.year, 365 * DAY);
});

test('only active rules and passed dates make items due; favorites have no exception', () => {
  const items = [
    item({ id: 1, favorite: 1 }),
    item({ id: 2, collection: '' }),
    item({ id: 3, collection: '', expires: NOW - 1 }),
    item({ id: 4, collection: '', expires: NOW + DAY }),
  ];
  assert.deepEqual(dueIds(items, [rule()], NOW), [1, 3]);
  assert.deepEqual(dueIds(items, [rule({ active: false })], NOW), [3]);
  assert.deepEqual(dueIds(items, [rule({ value: '' })], NOW), [3]);
});

test('days left in the trash count down from 30', () => {
  const now = Date.now();
  assert.equal(daysLeft(now, now), 30);
  assert.equal(daysLeft(now - 29.5 * DAY * 1000, now), 1);
  assert.equal(daysLeft(now - 31 * DAY * 1000, now), 0);
});

test('site values are validated and reduced to the domain', () => {
  assert.equal(normalizeSite('youtube.com'), 'youtube.com');
  assert.equal(normalizeSite('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(normalizeSite('es.wikipedia.org/wiki/X'), 'es.wikipedia.org');
  assert.equal(normalizeSite('localhost:8080'), 'localhost');
  assert.equal(normalizeSite('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(normalizeSite('youtube'), '');
  assert.equal(normalizeSite('you tube.com'), '');
  assert.equal(normalizeSite('-bad-.com'), '');
  assert.equal(normalizeSite('site.c0m'), '');
  assert.equal(normalizeSite(''), '');
});

test('rule values get a message explaining what is wrong', () => {
  assert.equal(ruleValueError('site', 'youtube.com'), '');
  assert.equal(ruleValueError('site', ''), 'ruleErrSiteEmpty');
  assert.equal(ruleValueError('site', 'hola'), 'ruleErrSite');
  assert.equal(ruleValueError('url', '/blog/ x'), 'ruleErrUrlSpaces');
  assert.equal(ruleValueError('url', '/blog/'), '');
  assert.equal(ruleValueError('title', ' '), 'ruleErrTextEmpty');
  assert.equal(ruleValueError('title', 'guía rápida'), '');
});
