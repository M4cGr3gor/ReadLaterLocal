// Automatic full backups into Downloads/ReadLaterLocal/. Off by default.
import { exportFull } from './db.js';
import { fullBackupToBlob, dateStamp } from './backup.js';
import { BACKUP_PERIOD_DAYS, getSettings, setSetting } from './settings.js';

const DAY = 24 * 60 * 60 * 1000;
let running = null;

export async function runBackup() {
  if (running) return running;
  running = (async () => {
    const settings = await getSettings();
    const blob = await fullBackupToBlob(await exportFull());
    const url = URL.createObjectURL(blob);
    const time = new Date().toTimeString().slice(0, 5).replace(':', '');
    const filename = `ReadLaterLocal/read-later-local-backup-${dateStamp()}-${time}.json.gz`;
    try {
      const id = await browser.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
      const files = [...settings.backup.files, id];
      // Keep only the newest N backup files; delete older ones from disk.
      while (files.length > settings.backup.keep) {
        const old = files.shift();
        await browser.downloads.removeFile(old).catch(() => {});
        await browser.downloads.erase({ id: old }).catch(() => {});
      }
      await setSetting('backup', { ...settings.backup, lastRun: Date.now(), files });
      return { ok: true, filename, bytes: blob.size };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

export async function backupIfDue() {
  const { backup } = await getSettings();
  if (!backup.enabled) return null;
  const period = (BACKUP_PERIOD_DAYS[backup.frequency] || 7) * DAY;
  if (Date.now() - backup.lastRun < period) return null;
  return runBackup();
}
