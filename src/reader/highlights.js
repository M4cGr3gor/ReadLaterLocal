// Highlights and notes in the reader. A highlight is stored as character offsets into the
// article's text (plus the text itself, to find it again if the article ever changes).
import * as db from '../lib/db.js';
import { t } from '../lib/i18n.js';
import { el, icon, toast } from '../lib/ui.js';

export const COLORS = ['yellow', 'green', 'blue', 'pink'];

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  while (walker.nextNode()) out.push(walker.currentNode);
  return out;
}

/**
 * Position of a DOM boundary point counted in root.textContent characters. Walks the text
 * nodes itself (Range.toString() doesn't count the same way in every browser).
 */
export function pointOffset(root, container, offset) {
  const inText = container.nodeType === Node.TEXT_NODE;
  const before = inText ? null : container.childNodes[offset] ?? null; // boundary sits before this node
  let pos = 0;
  for (const node of textNodes(root)) {
    if (inText) {
      if (node === container) return pos + offset;
    } else if (before) {
      if (node === before || (before.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return pos;
    } else if (!container.contains(node) && (container.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      return pos; // boundary at the end of container
    }
    pos += node.data.length;
  }
  return pos;
}

/** Character offsets of a DOM range inside root's text. */
export function rangeOffsets(root, range) {
  return {
    start: pointOffset(root, range.startContainer, range.startOffset),
    end: pointOffset(root, range.endContainer, range.endOffset),
  };
}

// Whitespace between paragraphs or list items isn't drawn; wrapping it in a <mark> would
// make it show up as an empty highlighted line. Only blank text that takes up room is marked.
function isLayoutGap(node) {
  if (node.data.trim()) return false;
  const r = document.createRange();
  r.selectNodeContents(node);
  const rect = r.getBoundingClientRect();
  return rect.width === 0 || rect.height === 0;
}

/** Wraps root's text between two offsets in <mark> elements (one per text node touched). */
export function wrapRange(root, start, end, make) {
  const marks = [];
  let pos = 0;
  for (const node of textNodes(root)) {
    const len = node.data.length;
    const s = Math.max(start, pos);
    const e = Math.min(end, pos + len);
    if (s < e) {
      let target = node;
      if (e - pos < len) target.splitText(e - pos);
      if (s - pos > 0) target = target.splitText(s - pos);
      if (!isLayoutGap(target)) {
        const mark = make();
        target.replaceWith(mark);
        mark.append(target);
        marks.push(mark);
      }
    }
    pos += len;
    if (pos >= end) break;
  }
  return marks;
}

function unwrap(mark) {
  const parent = mark.parentNode;
  mark.replaceWith(...mark.childNodes);
  parent?.normalize();
}

/**
 * Where the highlight is in the current text: its stored offsets if the text there still
 * matches, otherwise the nearest place with the same text, or null if it's gone.
 */
export function locate(fullText, h) {
  if (fullText.slice(h.start, h.end) === h.text) return { start: h.start, end: h.end };
  let best = -1;
  for (let i = fullText.indexOf(h.text); i !== -1; i = fullText.indexOf(h.text, i + 1)) {
    if (best === -1 || Math.abs(i - h.start) < Math.abs(best - h.start)) best = i;
  }
  return best === -1 || !h.text ? null : { start: best, end: best + h.text.length };
}

/** Sets up highlighting on the article. Returns { render, count }. */
export function setupHighlights({ root, item, panel, toggle, countEl, toasts, color = () => 'yellow', mode = () => false }) {
  let list = [];
  const marksOf = id => root.querySelectorAll(`mark.hl[data-hl="${id}"]`);

  const makeMark = h => () => {
    const m = el('mark', { class: `hl hl-${h.color}${h.note ? ' has-note' : ''}`, dataset: { hl: h.id } });
    if (h.note) m.title = h.note;
    return m;
  };

  function paint(h) {
    for (const m of marksOf(h.id)) unwrap(m);
    const at = locate(root.textContent, h);
    h.lost = !at;
    if (at) wrapRange(root, at.start, at.end, makeMark(h));
    return at;
  }

  async function render() {
    list = await db.getHighlights(item.id);
    const text = root.textContent;
    for (const h of list) {
      const at = locate(text, h);
      if (at && (at.start !== h.start || at.end !== h.end)) Object.assign(h, await db.saveHighlight({ ...h, ...at }));
    }
    for (const h of list) paint(h);
    renderPanel();
  }

  // ---- floating toolbar ----
  const bar = el('div', { class: 'hl-bar', role: 'toolbar', hidden: true });
  const note = el('div', { class: 'hl-note', hidden: true });
  document.body.append(bar, note);
  let pending = null; // { start, end, text } of a new selection
  let current = null; // highlight being edited

  const place = (node, rect, below = false) => {
    node.hidden = false;
    const w = node.offsetWidth;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8));
    const top = below ? rect.bottom + 8 : rect.top - node.offsetHeight - 8;
    node.style.left = `${left + window.scrollX}px`;
    node.style.top = `${Math.max(8, top) + window.scrollY}px`;
  };
  const hideBar = () => { bar.hidden = true; pending = null; current = null; };
  const hideNote = () => { note.hidden = true; };

  function swatches(active) {
    return COLORS.map(c => el('button', {
      class: `swatch hl-${c}${c === active ? ' on' : ''}`, type: 'button', title: t('hlColor_' + c), 'aria-label': t('hlColor_' + c),
      onmousedown: e => e.preventDefault(),
      onclick: () => (current ? recolor(current, c) : create(c)),
    }));
  }
  const barBtn = (name, label, fn, cls = '') => el('button', {
    class: `bar-icon ${cls}`, type: 'button', title: label, 'aria-label': label,
    onmousedown: e => e.preventDefault(), onclick: fn,
  }, icon(name));

  // New highlights use the colour chosen in the reader settings (or the side panel).
  function showCreateBar(range) {
    current = null;
    bar.replaceChildren(
      el('button', { class: 'hl-do', type: 'button', title: t('hlDoTitle'), onmousedown: e => e.preventDefault(), onclick: () => create(color()) },
        el('span', { class: `dot hl-${color()}` }), t('hlDo')),
      barBtn('note', t('hlAddNote'), async () => {
        const h = await create(color());
        if (h) editNote(h);
      }));
    place(bar, range.getBoundingClientRect());
  }

  function showEditBar(h, mark) {
    pending = null;
    current = h;
    bar.replaceChildren(...swatches(h.color),
      barBtn('note', h.note ? t('hlEditNote') : t('hlAddNote'), () => editNote(h)),
      barBtn('copy', t('hlCopy'), async () => { await navigator.clipboard.writeText(h.text); toast(toasts, t('hlCopied')); hideBar(); }),
      barBtn('trash', t('hlDelete'), () => remove(h), 'danger'));
    place(bar, mark.getBoundingClientRect());
  }

  function selectionInArticle() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    let { start, end } = rangeOffsets(root, range);
    const full = root.textContent;
    while (start < end && /\s/.test(full[start])) start++;
    while (end > start && /\s/.test(full[end - 1])) end--;
    if (end <= start) return null;
    return { range, start, end, text: full.slice(start, end) };
  }

  const onSelect = () => setTimeout(() => {
    if (!note.hidden) return;
    const s = selectionInArticle();
    if (!s) { if (!current) bar.hidden = true; return; }
    pending = { start: s.start, end: s.end, text: s.text };
    if (mode()) autoHighlight();
    else showCreateBar(s.range);
  }, 10);

  // Highlighter mode: the selection is highlighted straight away; the bar only offers a note.
  async function autoHighlight() {
    const h = await create(color());
    const mark = h && marksOf(h.id)[0];
    if (!mark) return;
    current = h;
    bar.replaceChildren(barBtn('note', t('hlAddNote'), () => editNote(h)));
    place(bar, mark.getBoundingClientRect());
  }
  root.addEventListener('mouseup', onSelect);
  root.addEventListener('keyup', e => { if (e.shiftKey) onSelect(); });
  // "H" highlights the current selection with the chosen colour.
  document.addEventListener('keydown', e => {
    if (e.key.toLowerCase() !== 'h' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea')) return;
    if (pending) { e.preventDefault(); create(color()); }
  });
  root.addEventListener('click', e => {
    const mark = e.target.closest('mark.hl');
    if (!mark || !document.getSelection().isCollapsed) return;
    const h = list.find(x => String(x.id) === mark.dataset.hl);
    if (h) showEditBar(h, mark);
  });
  document.addEventListener('mousedown', e => {
    if (!bar.contains(e.target) && !note.contains(e.target) && !e.target.closest?.('mark.hl')) hideBar();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideBar(); hideNote(); } });

  // ---- actions ----
  async function create(color) {
    if (!pending) return null;
    const h = await db.saveHighlight({ itemId: item.id, ...pending, color, note: '' });
    list.push(h);
    list.sort((a, b) => a.start - b.start);
    paint(h);
    document.getSelection().removeAllRanges();
    hideBar();
    renderPanel();
    return h;
  }

  async function recolor(h, color) {
    Object.assign(h, await db.saveHighlight({ ...h, color }));
    paint(h);
    hideBar();
    renderPanel();
  }

  async function remove(h) {
    await db.deleteHighlight(h.id);
    for (const m of marksOf(h.id)) unwrap(m);
    list = list.filter(x => x.id !== h.id);
    hideBar();
    renderPanel();
    toast(toasts, t('hlDeleted'), {
      label: t('undo'),
      run: async () => {
        const { id: _old, ...rest } = h;
        const back = await db.saveHighlight(rest);
        list.push(back);
        list.sort((a, b) => a.start - b.start);
        paint(back);
        renderPanel();
      },
    });
  }

  function editNote(h) {
    hideBar();
    const area = el('textarea', { maxlength: '5000', placeholder: t('hlNotePlaceholder'), 'aria-label': t('hlNotePlaceholder') });
    area.value = h.note || '';
    const save = async () => {
      Object.assign(h, await db.saveHighlight({ ...h, note: area.value.trim() }));
      paint(h);
      hideNote();
      renderPanel();
    };
    area.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') hideNote();
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); }
    });
    note.replaceChildren(area, el('div', { class: 'hl-note-actions' },
      el('small', {}, t('noteHelp')),
      el('button', { class: 'fetch-btn', type: 'button', onclick: hideNote }, t('cancel')),
      el('button', { class: 'fetch-btn primary', type: 'button', onclick: save }, t('save'))));
    const mark = marksOf(h.id)[0];
    place(note, (mark || root).getBoundingClientRect(), true);
    area.focus();
  }

  // ---- side panel with every highlight ----
  function renderPanel() {
    countEl.textContent = list.length ? String(list.length) : '';
    countEl.hidden = !list.length;
    const body = list.length
      ? list.map(h => el('li', { class: `hl-item hl-${h.color}${h.lost ? ' lost' : ''}` },
        el('button', { class: 'hl-quote', type: 'button', title: h.lost ? t('hlLost') : t('hlGoTo'), onclick: () => goTo(h) }, h.text.length > 280 ? h.text.slice(0, 280) + '…' : h.text),
        h.note ? el('p', { class: 'hl-item-note' }, h.note) : null,
        h.lost ? el('p', { class: 'hl-item-lost' }, t('hlLost')) : null,
        el('div', { class: 'hl-item-actions' },
          el('button', { class: 'link', type: 'button', onclick: () => { goTo(h); editNote(h); } }, h.note ? t('hlEditNote') : t('hlAddNote')),
          el('button', { class: 'link danger', type: 'button', onclick: () => remove(h) }, t('hlDelete')))))
      : [el('li', { class: 'hl-empty' }, t('hlEmpty'))];
    panel.querySelector('.hl-list').replaceChildren(...body);
    panel.querySelector('.hl-export').disabled = !list.length;
  }

  function goTo(h) {
    const mark = marksOf(h.id)[0];
    if (!mark) return;
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    for (const m of marksOf(h.id)) { m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash'); }
  }

  toggle.addEventListener('click', e => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  panel.querySelector('.hl-close').addEventListener('click', () => { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); });
  panel.querySelector('.hl-export').addEventListener('click', async () => {
    const lines = [`# ${document.title}`, '', item.url, ''];
    for (const h of list) {
      lines.push(...h.text.split('\n').map(l => `> ${l}`), '');
      if (h.note) lines.push(h.note, '');
    }
    await navigator.clipboard.writeText(lines.join('\n'));
    toast(toasts, t('hlExported'));
  });

  /** Item fields changed elsewhere (another tab): keep the reference up to date. */
  const setItem = next => { item = next; };
  return { render, setItem, count: () => list.length };
}
