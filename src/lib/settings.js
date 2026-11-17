// User preferences in storage.local (tiny; the data itself lives in IndexedDB).
export const DEFAULTS = {
  view: 'grid',
  backup: { enabled: false, frequency: 'weekly', keep: 3, lastRun: 0, files: [] },
  reader: { theme: 'system', size: 19, width: 'medium', font: 'serif', hlColor: 'yellow', autoArchive: true, ttsRate: 1, ttsVoice: '' },
};

export async function getSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS)).catch(() => ({}));
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    out[k] = def && typeof def === 'object' && !Array.isArray(def) ? { ...def, ...(stored[k] || {}) } : (stored[k] ?? def);
  }
  return out;
}

export async function setSetting(key, value) {
  await browser.storage.local.set({ [key]: value });
}

export const BACKUP_PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };
