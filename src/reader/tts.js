// Listen to the article with the voices installed in the system (free, works offline).
// It reads one paragraph at a time, marks it and keeps it on screen.
const SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, dt, dd, td, th, pre';
const MAX_CHUNK = 1200; // long paragraphs are split at sentence ends (some voices cut long texts)
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export const speechAvailable = () => 'speechSynthesis' in globalThis;

/** The voices installed, waiting for the list (it often arrives a moment after the page loads). */
export function loadVoices() {
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise(resolve => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

/** The best voice for a language: the one chosen before, else the same language and country, else the same language. */
export function pickVoice(voices, lang, preferred = '') {
  const chosen = voices.find(v => v.voiceURI === preferred);
  if (chosen) return chosen;
  const want = String(lang || '').toLowerCase().replace('_', '-');
  const base = want.split('-')[0];
  return voices.find(v => v.lang.toLowerCase() === want)
    || voices.find(v => v.lang.toLowerCase().split('-')[0] === base && v.default)
    || voices.find(v => v.lang.toLowerCase().split('-')[0] === base)
    || null;
}

function splitText(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const out = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    const cut = rest.lastIndexOf('. ', MAX_CHUNK);
    const at = cut > MAX_CHUNK / 3 ? cut + 1 : MAX_CHUNK;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * @param {{root:HTMLElement, getVoice:()=>SpeechSynthesisVoice|null, getRate:()=>number,
 *          onChange:(state:{playing:boolean, active:boolean})=>void, onEnd:()=>void,
 *          onError?:(error:string)=>void}} opts
 */
export function createReader({ root, getVoice, getRate, onChange, onEnd, onError = () => {} }) {
  let blocks = [];
  let index = 0;
  let chunk = 0;
  let playing = false;
  let active = false;
  let token = 0; // utterances from before a pause/jump are ignored when they end
  let current = null;

  const textOf = el => el.textContent.replace(/\s+/g, ' ').trim();
  const collect = () => {
    // A list item or quote holding paragraphs is read through its paragraphs.
    blocks = [...root.querySelectorAll(SELECTOR)].filter(el => !el.querySelector(SELECTOR) && textOf(el));
  };

  const mark = el => {
    current?.classList.remove('tts-now');
    current = el;
    if (!el) return;
    el.classList.add('tts-now');
    const r = el.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 80) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const emit = () => onChange({ playing, active });

  function speak() {
    const el = blocks[index];
    if (!el) { stop(); onEnd(); return; }
    mark(el);
    const parts = splitText(textOf(el));
    const u = new SpeechSynthesisUtterance(parts[chunk] || '');
    const voice = getVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = getRate();
    const mine = ++token;
    u.onend = () => {
      if (mine !== token || !playing) return;
      if (++chunk >= parts.length) { chunk = 0; index++; }
      speak();
    };
    // A failing voice stops here: skipping ahead would "finish" (and archive) an unread article.
    u.onerror = e => {
      if (mine !== token || e.error === 'interrupted' || e.error === 'canceled') return;
      stop();
      onError(e.error);
    };
    speechSynthesis.speak(u);
  }

  // The first paragraph visible on screen (or the one holding the selection) is where reading starts.
  function startIndex() {
    const sel = document.getSelection();
    if (sel?.rangeCount && !sel.isCollapsed) {
      const i = blocks.findIndex(b => b.contains(sel.anchorNode));
      if (i >= 0) return i;
    }
    const i = blocks.findIndex(b => b.getBoundingClientRect().bottom > 70);
    return i >= 0 ? i : 0;
  }

  function play() {
    if (!active) { collect(); index = startIndex(); chunk = 0; active = true; }
    playing = true;
    speechSynthesis.cancel();
    speak();
    emit();
  }

  function pause() {
    playing = false;
    token++;
    speechSynthesis.cancel();
    emit();
  }

  function stop() {
    playing = false;
    active = false;
    token++;
    speechSynthesis.cancel();
    mark(null);
    emit();
  }

  const jump = delta => {
    if (!active) return;
    index = Math.max(0, Math.min(blocks.length - 1, index + delta));
    chunk = 0;
    if (playing) { token++; speechSynthesis.cancel(); speak(); } else mark(blocks[index]);
  };

  // A new speed or voice starts the current paragraph again with it.
  const restart = () => { if (playing) { chunk = 0; token++; speechSynthesis.cancel(); speak(); } };

  addEventListener('pagehide', () => speechSynthesis.cancel());
  return { play, pause, stop, toggle: () => (playing ? pause() : play()), next: () => jump(1), prev: () => jump(-1), restart, get active() { return active; } };
}
