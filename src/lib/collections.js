// Collections: like folders, each item is in at most one. Stored as a small list in
// storage.local; items keep the collection id.
import { clearCollection } from './db.js';
import { loadRules, saveRules } from './rules.js';

export async function loadCollections() {
  const { collections = [] } = await browser.storage.local.get('collections').catch(() => ({}));
  return collections;
}

async function save(list) {
  await browser.storage.local.set({ collections: list });
}

export async function createCollection(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return null;
  const list = await loadCollections();
  const existing = list.find(c => c.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const col = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: clean };
  await save([...list, col].sort((a, b) => a.name.localeCompare(b.name)));
  return col;
}

export async function renameCollection(id, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return;
  const list = await loadCollections();
  await save(list.map(c => (c.id === id ? { ...c, name: clean } : c)).sort((a, b) => a.name.localeCompare(b.name)));
}

// Items in it stay, just without collection; rules pointing to it forget it.
export async function deleteCollection(id) {
  await save((await loadCollections()).filter(c => c.id !== id));
  await clearCollection(id);
  await saveRules((await loadRules()).map(r => (r.collection === id ? { ...r, collection: '' } : r)));
}

export function collectionName(list, id) {
  return list.find(c => c.id === id)?.name || '';
}
