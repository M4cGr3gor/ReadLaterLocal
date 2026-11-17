// Icon sets for the toolbar button (with the unread counter) and the address-bar button.
// Paths are relative to the extension root.
export const ICON_STYLES = {
  bookmark: { toolbar: 'icons/icon.svg', save: 'icons/save.svg', saved: 'icons/saved.svg' },
  book: { toolbar: 'icons/book-toolbar.svg', save: 'icons/book-save.svg', saved: 'icons/book-saved.svg' },
  minimal: { toolbar: 'icons/minimal-toolbar.svg', save: 'icons/minimal-save.svg', saved: 'icons/minimal-saved.svg' },
};

export async function iconStyle() {
  const { iconStyle: s } = await browser.storage.local.get('iconStyle').catch(() => ({}));
  return ICON_STYLES[s] ? s : 'bookmark';
}

export async function iconSet() {
  return ICON_STYLES[await iconStyle()];
}
