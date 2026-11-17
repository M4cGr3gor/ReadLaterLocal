// Reading position: the article opens where it was left, a thin bar shows how far you are,
// and reaching the end can archive it.
import * as db from '../lib/db.js';

const SAVE_DELAY = 1500; // ms after scrolling stops
const END_MARGIN = 80; // px from the bottom that count as "the end"

/**
 * @param {{id:number, bar:HTMLElement, content:HTMLElement, onFinish:()=>void}} opts
 * @returns {{restore:()=>Promise<void>, engage:()=>void, forget:()=>Promise<void>}}
 */
export function setupProgress({ id, bar, content, onFinish }) {
  const scroller = document.scrollingElement;
  let engaged = false; // the reader moved through the page themselves (or is listening to it)
  let finished = false;
  let saveTimer = 0;
  let frame = 0;
  let restoredAt = 0;

  const room = () => scroller.scrollHeight - innerHeight;
  const fraction = () => (room() > 0 ? Math.min(1, scroller.scrollTop / room()) : 1);
  const atEnd = () => room() > 0 && scroller.scrollTop >= room() - END_MARGIN;

  // At the end the position is forgotten: next time it opens from the top.
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = 0;
    db.setPosition(id, atEnd() ? 0 : fraction()).catch(() => {});
  };

  const paint = () => {
    frame = 0;
    bar.style.transform = `scaleX(${fraction()})`;
  };

  function onScroll() {
    if (!frame) frame = requestAnimationFrame(paint);
    if (!engaged) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
    // Only for articles longer than a screen and a half, so a short one isn't archived on opening.
    if (!finished && atEnd() && room() > innerHeight / 2) {
      finished = true;
      onFinish();
    }
  }

  const engage = () => { engaged = true; };
  for (const type of ['wheel', 'keydown', 'mousedown', 'touchstart']) {
    addEventListener(type, engage, { passive: true, capture: true });
  }
  addEventListener('scroll', onScroll, { passive: true });
  // Leaving the page (closing the tab, going back…) saves at once.
  const flush = () => { if (saveTimer) save(); };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // Pictures that load after the jump push the text down: jump again until the reader moves.
  content.addEventListener('load', () => {
    if (!engaged && restoredAt) scroller.scrollTop = restoredAt * room();
  }, true);

  return {
    async restore() {
      const at = await db.getPosition(id);
      if (at > 0.01 && at < 1) {
        restoredAt = at;
        scroller.scrollTop = at * room();
      }
      paint();
    },
    engage,
    async forget() {
      clearTimeout(saveTimer);
      saveTimer = 0;
      await db.setPosition(id, 0);
    },
  };
}
