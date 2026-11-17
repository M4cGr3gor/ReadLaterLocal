import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSavableUrl, normalize, displayTitle, hostOf, colorForHost } from '../src/lib/util.js';

test('isSavableUrl only accepts http and https', () => {
  assert.equal(isSavableUrl('https://a.com'), true);
  assert.equal(isSavableUrl('http://a.com/x'), true);
  assert.equal(isSavableUrl('about:config'), false);
  assert.equal(isSavableUrl('moz-extension://x/y'), false);
  assert.equal(isSavableUrl('javascript:alert(1)'), false);
  assert.equal(isSavableUrl(''), false);
  assert.equal(isSavableUrl('not a url'), false);
});

test('normalize lowercases and removes accents', () => {
  assert.equal(normalize('Guía ÁRBOL Ñandú'), 'guia arbol nandu');
});

test('displayTitle prettifies titles that are just the url', () => {
  const u = 'https://www.x.com/a/';
  assert.equal(displayTitle({ title: u, url: u }), 'x.com/a');
  assert.equal(displayTitle({ title: '', url: 'https://debian-handbook.info/browse/stable/' }), 'debian-handbook.info/browse/stable');
  assert.equal(displayTitle({ title: 'Real', url: u }), 'Real');
});

test('hostOf strips www and survives bad input', () => {
  assert.equal(hostOf('https://www.youtube.com/watch?v=1'), 'youtube.com');
  assert.equal(hostOf('garbage'), '');
});

test('colorForHost is stable and in range', () => {
  const c = colorForHost('github.com');
  assert.equal(c, colorForHost('github.com'));
  assert.ok(c >= 0 && c < 8);
});
