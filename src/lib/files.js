// Saving files through Firefox's downloads (so manual copies can ask "Save as…").

/**
 * Saves a Blob as a download. With saveAs Firefox shows its "Save as" dialog.
 * @returns {Promise<number|null>} download id, or null if the user cancelled the dialog
 */
export async function saveFile(blob, filename, { saveAs = false } = {}) {
  const url = URL.createObjectURL(blob);
  let id;
  try {
    id = await browser.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
  } catch (err) {
    URL.revokeObjectURL(url);
    if (/cancel/i.test(String(err?.message || err))) return null;
    throw err;
  }
  // Free the Blob once Firefox has finished writing it (or after a while, whatever happens).
  const done = () => { URL.revokeObjectURL(url); browser.downloads.onChanged.removeListener(watch); };
  const watch = delta => { if (delta.id === id && ['complete', 'interrupted'].includes(delta.state?.current)) done(); };
  browser.downloads.onChanged.addListener(watch);
  setTimeout(done, 10 * 60 * 1000);
  return id;
}

/** Resolves when the download has finished (true) or failed (false). */
export function whenDownloaded(id) {
  return new Promise(resolve => {
    const watch = delta => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') { browser.downloads.onChanged.removeListener(watch); resolve(true); }
      if (delta.state.current === 'interrupted') { browser.downloads.onChanged.removeListener(watch); resolve(false); }
    };
    browser.downloads.onChanged.addListener(watch);
    browser.downloads.search({ id }).then(([d]) => {
      if (d?.state === 'complete') { browser.downloads.onChanged.removeListener(watch); resolve(true); }
    }).catch(() => {});
  });
}

/** A file name made from a title: no characters Windows/macOS reject, not too long. */
export function safeFileName(title, ext) {
  const base = String(title || 'articulo')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80) || 'articulo';
  return `${base}.${ext}`;
}
