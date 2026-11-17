// Rough timings of the database calls the pages use most, with N fake items.
// Run: node dev/bench.mjs [N]
import 'fake-indexeddb/auto';
import * as db from '../src/lib/db.js';

const N = Number(process.argv[2]) || 2000;
const words = 'el la de que y en un ser se no haber por con su para como estar tener le lo todo pero más hacer o poder decir este ir otro ese si me ya ver porque dar cuando él muy sin vez mucho saber qué sobre mi alguno mismo yo también hasta año dos querer entre así primero desde grande eso ni nos llegar pasar tiempo ella sí día uno bien poco deber entonces poner cosa tanto hombre parecer nuestro tan donde ahora parte después vida quedar siempre creer hablar llevar dejar nada cada seguir menos nuevo encontrar algo solo pues llamar venir pensar salir volver tomar conocer vivir sentir tratar mirar contar empezar esperar buscar existir entrar trabajar escribir perder producir ocurrir entender pedir recibir recordar terminar permitir aparecer conseguir comenzar servir sacar necesitar mantener resultar leer caer cambiar presentar crear abrir considerar oír acabar convertir ganar formar traer partir morir aceptar realizar suponer comprender lograr explicar'.split(' ');
const article = n => Array.from({ length: 1500 }, (_, i) => words[(i * 7 + n) % words.length] + (i % 13 === 0 ? ',' : '')).join(' ');

const time = async (label, fn, runs = 5) => {
  await fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  console.log(`${label.padEnd(28)} ${((performance.now() - t0) / runs).toFixed(1)} ms`);
};

await db.clearAll();
const tImport = performance.now();
await db.importRecords(Array.from({ length: N }, (_, i) => ({
  title: `Artículo ${i}`, url: `https://site${i % 80}.com/p/${i}`, time_added: 1_600_000_000 + i,
  tags: [`t${i % 25}`, `g${i % 7}`], status: i % 3 ? 'unread' : 'archive', favorite: i % 11 === 0 ? 1 : 0,
})));
console.log(`import ${N} items`.padEnd(28) + ` ${(performance.now() - tImport).toFixed(0)} ms`);
const ids = (await db.allItems()).map(i => i.id);
for (const id of ids.slice(0, 400)) await db.setText(id, article(id));

await time('counts()', () => db.counts());
await time('unreadCount()', () => db.unreadCount());
await time('facets (list bar, 1 pass)', () => db.facetStats());
await time('page() first 30', () => db.page({ status: 'unread', limit: 30 }));
await time('text search (400 texts)', () => db.page({ status: 'all', query: 'convertir explicar', limit: 30 }));
await time('itemsWithBrokenText()', () => db.itemsWithBrokenText());
const stats = await db.storageStats();
console.log('storage', JSON.stringify(stats));

// Space of the searchable text with real prose (the project's README files).
import { readFileSync } from 'node:fs';
import { normalize } from '../src/lib/util.js';
const prose = ['README.md', 'README.es.md']
  .map(f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
const full = normalize(prose).replace(/\s+/g, ' ').trim();
console.log(`real prose: full ${full.length} chars -> compact ${db.searchText(prose).length} chars`);
