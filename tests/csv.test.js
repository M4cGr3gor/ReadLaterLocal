import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, rowsToRecords, recordsToCsv } from '../src/lib/csv.js';

test('parseCsv handles quotes, commas and newlines inside fields', () => {
  const text = 'a,b\n"x, ""y""\nz",2\n';
  assert.deepEqual(parseCsv(text), [['a', 'b'], ['x, "y"\nz', '2']]);
});

test('parseCsv strips BOM and accepts CRLF', () => {
  const text = '﻿title,url\r\nT,https://a.com\r\n';
  assert.deepEqual(parseCsv(text), [['title', 'url'], ['T', 'https://a.com']]);
});

test('rowsToRecords maps columns by header name in any order', () => {
  const rows = parseCsv('status,url,title,time_added,tags\narchive,https://a.com/,Hola,1500000000,x|y\n');
  const { records, invalid } = rowsToRecords(rows);
  assert.equal(invalid, 0);
  assert.deepEqual(records, [{ title: 'Hola', url: 'https://a.com/', time_added: 1500000000, tags: ['x', 'y'], status: 'archive', favorite: 0 }]);
});

test('rowsToRecords reads the optional favorite column', () => {
  const { records } = rowsToRecords(parseCsv('title,url,time_added,tags,status,favorite\nA,https://a.com,1,,unread,1\nB,https://b.com,1,,unread,0\n'));
  assert.deepEqual(records.map(r => r.favorite), [1, 0]);
});

test('rowsToRecords counts non-http urls and empty urls as invalid', () => {
  const rows = parseCsv('title,url,time_added,tags,status\nA,javascript:alert(1),1,,unread\nB,,1,,unread\nC,about:config,1,,unread\nD,http://ok.com,1,,unread\n');
  const { records, invalid } = rowsToRecords(rows);
  assert.equal(invalid, 3);
  assert.equal(records.length, 1);
  assert.equal(records[0].url, 'http://ok.com');
});

test('rowsToRecords fills defaults: empty title -> url, bad status -> unread, bad time -> now', () => {
  const before = Math.floor(Date.now() / 1000);
  const { records } = rowsToRecords(parseCsv('title,url,time_added,tags,status\n,https://b.com,abc,,weird\n'));
  assert.equal(records[0].title, 'https://b.com');
  assert.equal(records[0].status, 'unread');
  assert.ok(records[0].time_added >= before);
});

test('rowsToRecords returns nothing when there is no url column', () => {
  const { records, invalid } = rowsToRecords(parseCsv('foo,bar\n1,2\n'));
  assert.equal(records.length, 0);
  assert.equal(invalid, 1);
});

test('recordsToCsv round-trips tricky titles, tags and favorites', () => {
  const recs = [
    { title: 'Título, con "comillas"\ny salto', url: 'https://a.com/?q=1,2', time_added: 1700000000, tags: [], status: 'unread', favorite: 1 },
    { title: 'Normal', url: 'https://b.com', time_added: 1600000000, tags: ['a', 'b'], status: 'archive', favorite: 0 },
  ];
  const csv = recordsToCsv(recs);
  assert.ok(csv.startsWith('title,url,time_added,tags,status,favorite\n'));
  assert.ok(csv.includes(',a|b,archive,0'));
  assert.deepEqual(rowsToRecords(parseCsv(csv)).records, recs);
});
