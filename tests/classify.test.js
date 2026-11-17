import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectKind, youtubeId, youtubeThumbUrl, readingMinutes, isShortRead, SHORT_READ_WORDS } from '../src/lib/classify.js';
import { ruleMatches, applyRules } from '../src/lib/rules.js';
import { suggestTags } from '../src/lib/suggest.js';
import { parseQuery, matchesQuery } from '../src/lib/util.js';

test('youtubeId understands the usual YouTube url shapes', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=D-dyo0zZ7OA'), 'D-dyo0zZ7OA');
  assert.equal(youtubeId('https://youtube.com/watch?v=7Eg34Sabn8U&t=30s'), '7Eg34Sabn8U');
  assert.equal(youtubeId('https://youtu.be/7Eg34Sabn8U?si=x'), '7Eg34Sabn8U');
  assert.equal(youtubeId('https://m.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(youtubeId('https://www.youtube.com/embed/abcdefghijk'), 'abcdefghijk');
  assert.equal(youtubeId('https://www.youtube.com/user/QuantumFracture'), null);
  assert.equal(youtubeId('https://example.com/watch?v=abcdefghijk'), null);
  assert.equal(youtubeThumbUrl('abcdefghijk'), 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
});

test('detectKind: videos by site, images by extension, articles by saved text', () => {
  assert.equal(detectKind({ url: 'https://www.youtube.com/watch?v=abcdefghijk' }), 'video');
  assert.equal(detectKind({ url: 'https://vimeo.com/12345' }), 'video');
  assert.equal(detectKind({ url: 'https://www.twitch.tv/videos/1' }), 'video');
  assert.equal(detectKind({ url: 'https://i.imgur.com/x.JPG' }), 'image');
  assert.equal(detectKind({ url: 'https://a.com/pic.webp?w=200' }), 'image');
  assert.equal(detectKind({ url: 'https://a.com/post', hasArticle: 1 }), 'article');
  assert.equal(detectKind({ url: 'https://github.com/x/y', fetchState: 2 }), 'other');
  assert.equal(detectKind({ url: 'https://a.com/post' }), 'unknown');
});

test('reading time: 220 words per minute, short reads are under 5 minutes', () => {
  assert.equal(readingMinutes(0), 0);
  assert.equal(readingMinutes(100), 1);
  assert.equal(readingMinutes(1100), 5);
  assert.equal(SHORT_READ_WORDS, 1100);
  assert.equal(isShortRead(1000), true);
  assert.equal(isShortRead(1100), true);
  assert.equal(isShortRead(1101), false);
  assert.equal(isShortRead(0), false);
  assert.equal(isShortRead(undefined), false);
});

test('ruleMatches checks site, url and title, ignoring case and accents', () => {
  const rec = { url: 'https://www.youtube.com/watch?v=x', title: 'Guía de Ryzen' };
  assert.equal(ruleMatches({ field: 'site', value: 'youtube.com' }, rec), true);
  assert.equal(ruleMatches({ field: 'site', value: 'tube.com' }, rec), false);
  assert.equal(ruleMatches({ field: 'site', value: 'youtu.be' }, rec), false);
  assert.equal(ruleMatches({ field: 'url', value: 'watch?v' }, rec), true);
  assert.equal(ruleMatches({ field: 'title', value: 'guia' }, rec), true);
  assert.equal(ruleMatches({ field: 'title', value: '' }, rec), false);
  assert.equal(ruleMatches({ field: 'site', value: 'youtube.com' }, { url: 'https://m.youtube.com/x', title: '' }), true);
});

test('applyRules adds tags, sets the collection and favorite, and leaves the rest alone', () => {
  const rules = [
    { field: 'site', value: 'youtube.com', tags: ['vídeo'], collection: 'c1' },
    { field: 'title', value: 'ryzen', tags: ['hardware'], favorite: true },
    { field: 'site', value: 'github.com', tags: ['code'] },
  ];
  const out = applyRules({ url: 'https://youtube.com/watch?v=1', title: 'Ryzen PBO', tags: ['old'], collection: '' }, rules);
  assert.deepEqual(out.tags, ['old', 'vídeo', 'hardware']);
  assert.equal(out.collection, 'c1');
  assert.equal(out.favorite, 1);
  const untouched = applyRules({ url: 'https://a.com', title: 'x', tags: [] }, rules);
  assert.deepEqual(untouched.tags, []);
  assert.equal(untouched.favorite, undefined);
});

test('applyRules never moves an item that already has a collection', () => {
  const out = applyRules({ url: 'https://youtube.com/x', title: '', tags: [], collection: 'mine' }, [{ field: 'site', value: 'youtube.com', collection: 'c1' }]);
  assert.equal(out.collection, 'mine');
});

test('suggestTags proposes tags used on the same site and tags found in the title', () => {
  const stats = {
    siteTags: new Map([['youtube.com', new Map([['vídeo', 5], ['hardware', 2]])]]),
    allTags: ['vídeo', 'hardware', 'css', 'ryzen', 'windows'],
  };
  const s = suggestTags({ url: 'https://www.youtube.com/watch?v=1', title: 'Optimizar Windows y Ryzen', tags: ['hardware'] }, stats);
  assert.deepEqual(s, ['vídeo', 'windows', 'ryzen']);
});

test('parseQuery and matchesQuery support site: and search inside notes', () => {
  const q = parseQuery('site:github.com tag:code firmware');
  assert.deepEqual(q.sites, ['github.com']);
  const item = { title: 'smalltv', url: 'https://github.com/a/b', tags: ['code'], note: 'Firmware para el reloj' };
  assert.equal(matchesQuery(item, q), true);
  assert.equal(matchesQuery({ ...item, url: 'https://gitlab.com/a' }, q), false);
  assert.equal(matchesQuery(item, parseQuery('reloj')), true);
});
