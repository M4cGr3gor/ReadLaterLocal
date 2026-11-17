// One theme for the whole extension: 'system' | 'light' | 'dark' | 'sepia'.
export const THEMES = ['system', 'light', 'dark', 'sepia'];

function set(theme) {
  document.documentElement.dataset.theme = THEMES.includes(theme) ? theme : 'system';
}

// Applies the saved theme and follows changes made from any other page.
export async function applyTheme() {
  const { theme, reader } = await browser.storage.local.get(['theme', 'reader']).catch(() => ({}));
  // Before v1.4 the theme lived in the reader settings only.
  set(theme || reader?.theme || 'system');
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) set(changes.theme.newValue);
  });
}

export async function saveTheme(theme) {
  set(theme);
  await browser.storage.local.set({ theme });
}
