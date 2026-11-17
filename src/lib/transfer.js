// Export / import shared by the list page and the data page.
import * as db from './db.js';
import { parseCsv, rowsToRecords, recordsToCsv } from './csv.js';
import { bookmarksHtml, dateStamp, fullBackupToBlob, readFullBackup } from './backup.js';
import { applyRules, loadRules } from './rules.js';
import { saveFile } from './files.js';

/**
 * Manual export: Firefox asks where to save it ("Save as"). Automatic backups don't come
 * through here; they always go to Downloads/ReadLaterLocal.
 * @returns {Promise<number|null>} items exported, or null if the dialog was cancelled
 */
export async function exportAs(kind, { images = false } = {}) {
  const stamp = dateStamp();
  const save = async (blob, name, n) => ((await saveFile(blob, name, { saveAs: true })) == null ? null : n);
  if (kind === 'full') {
    const data = await db.exportFull({ images });
    return save(await fullBackupToBlob(data), `read-later-local-backup-${stamp}.json.gz`, data.items.length);
  }
  const items = await db.allItems();
  if (kind === 'html') return save(new Blob([bookmarksHtml(items)], { type: 'text/html' }), `read-later-local-${stamp}.html`, items.length);
  if (kind === 'md') {
    const { linksMarkdown } = await import('./markdown.js');
    return save(new Blob([linksMarkdown(items, `Read Later Local · ${stamp}`)], { type: 'text/markdown;charset=utf-8' }), `read-later-local-${stamp}.md`, items.length);
  }
  return save(new Blob([recordsToCsv(items)], { type: 'text/csv;charset=utf-8' }), `read-later-local-${stamp}.csv`, items.length);
}

/**
 * Imports a Pocket/our CSV or a full backup (.json.gz / .json).
 * @returns {Promise<{added:number, skipped:number, invalid:number}>}
 */
export async function importFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.gz') || name.endsWith('.json')) {
    const { added, merged } = await db.importFull(await readFullBackup(file));
    return { added, skipped: merged, invalid: 0 };
  }
  const { records, invalid } = rowsToRecords(parseCsv(await file.text()));
  if (!records.length && !invalid) throw new Error('empty');
  const rules = await loadRules();
  const { added, duplicates } = await db.importRecords(records.map(r => applyRules(r, rules)));
  return { added, skipped: duplicates, invalid };
}

export const IMPORT_ACCEPT = '.csv,.json,.gz,text/csv,application/json,application/gzip';
