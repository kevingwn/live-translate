/**
 * Caption rendering for one column.
 *
 * Two rules drive the whole design:
 *
 * 1. Deltas arrive 20-40x/sec across two streams. innerHTML += is O(n^2)
 *    reflow, so every line owns exactly one Text node and we only ever touch
 *    its .data.
 * 2. The model is updated synchronously in onmessage and never dropped; only
 *    the *render* is rAF-batched. A backgrounded tab stalls rAF but not the
 *    socket, so this way refocusing catches up instead of showing a hole.
 *
 * Nothing untrusted ever reaches innerHTML. That is a security property here,
 * not only a performance one.
 *
 * Both columns segment locally. Neither endpoint gives us usable turn
 * boundaries: the translations stream has no item ids and no completion event
 * at all, and gpt-live-transcribe refuses turn_detection, so every delta in an
 * uncommitted stretch carries the same item_id and would otherwise render as
 * one endlessly growing line.
 */

const PUNCT_END = /[.!?。？！…]["'”’)\]]?\s*$/;
const SOFT_BREAK = /[,;:、，]/g;

// Latin sentences end at a mark followed by space *and* more text; CJK needs no
// space, so it splits on the mark itself.
const CJK_END = /[。？！]/g;
const LATIN_END = /[.!?…]["'”’)\]]?(?=\s)/g;
const ABBREV = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|st|vs|etc|inc|ltd|jr|sr|no|fig|approx|al)\.$/i;
// Dotted initialisms -- p.m., a.m., e.g., i.e., U.S. -- end in a run of
// single-letter-plus-dot groups and are never sentence ends.
const INITIALISM = /(?:\b[A-Za-z]\.){2,}$/;

const PUNCT_FLUSH_MS = 400;   // finalises a trailing sentence once speech stops
const GAP_FLUSH_MS = 1200;    // silence ends a line
const SOFT_SPLIT_CHARS = 240; // stop a line growing without bound
const MIN_SENTENCE = 8;       // don't strand a fragment on its own line

/**
 * Index to cut at once a sentence is provably complete, or -1.
 *
 * Waiting on a timer does not work: deltas arrive every ~280 ms during
 * continuous speech and each one cancels the pending timer, so sentences never
 * split and the column fills with paragraphs. A boundary is only trusted once
 * real text follows it, which also means it can never cut a live line early.
 */
function sentenceCut(text) {
  let cut = -1;
  let m;

  CJK_END.lastIndex = 0;
  while ((m = CJK_END.exec(text)) !== null) {
    const end = m.index + 1;
    if (end < text.length && end > MIN_SENTENCE) cut = Math.max(cut, end);
  }

  LATIN_END.lastIndex = 0;
  while ((m = LATIN_END.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end <= MIN_SENTENCE) continue;
    const head = text.slice(0, end);
    if (ABBREV.test(head) || INITIALISM.test(head)) continue; // "Mr.", "p.m."
    if (!/^\s+\S/.test(text.slice(end))) continue;   // nothing after it yet
    cut = Math.max(cut, end);
  }
  return cut;
}

function mmss(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

export function createColumn(container) {
  const lines = [];
  const dirty = new Set();
  let frame = null;
  let onPinChange = null;

  function isPinned() {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  }

  function scheduleRender() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const pinned = isPinned();
      for (const line of dirty) line.textNode.data = line.text;
      dirty.clear();
      if (pinned) container.scrollTop = container.scrollHeight;
      if (onPinChange) onPinChange(isPinned());
    });
  }

  function newLine(tMs) {
    const el = document.createElement('p');
    el.className = 'line live';

    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = mmss(tMs || 0);
    el.appendChild(stamp);

    const textNode = document.createTextNode('');
    el.appendChild(textNode);

    container.appendChild(el);
    const line = { el, textNode, text: '', final: false, tMs: tMs || 0 };
    lines.push(line);
    return line;
  }

  function finalize(line) {
    if (!line || line.final) return;
    line.final = true;
    // Flush synchronously before dropping the line from `dirty`. Text set in
    // this same tick has not been rendered yet and would otherwise be lost.
    line.textNode.data = line.text;
    line.el.className = 'line final';
    if (!line.text.trim()) {
      line.el.remove();
      const i = lines.indexOf(line);
      if (i >= 0) lines.splice(i, 1);
    }
    dirty.delete(line);
  }

  function setText(line, text) {
    line.text = text;
    dirty.add(line);
    scheduleRender();
  }

  return {
    container, lines, newLine, finalize, setText, isPinned,
    onPin(fn) { onPinChange = fn; },
    scrollToLive() {
      container.scrollTop = container.scrollHeight;
      if (onPinChange) onPinChange(true);
    },
    /** A visible seam for reconnects and language switches. */
    divider(text) {
      const el = document.createElement('div');
      el.className = 'divider';
      el.textContent = text;
      container.appendChild(el);
      if (isPinned()) container.scrollTop = container.scrollHeight;
    },
    clear() {
      lines.length = 0;
      dirty.clear();
      container.replaceChildren();
    },
  };
}

/** Append-only delta text -> readable lines, with no help from the server. */
function segmenter(col) {
  let open = null;
  let punctTimer = null;
  let gapTimer = null;
  let linesThisRun = 0;

  function clearTimers() {
    if (punctTimer) { clearTimeout(punctTimer); punctTimer = null; }
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  }

  function flush() {
    clearTimers();
    if (open) { col.finalize(open); open = null; }
  }

  function softSplit(tMs) {
    if (!open || open.text.length < SOFT_SPLIT_CHARS) return;
    SOFT_BREAK.lastIndex = 0;
    let cut = -1;
    let m;
    while ((m = SOFT_BREAK.exec(open.text)) !== null) cut = m.index;
    if (cut < 40) return;

    const head = open.text.slice(0, cut + 1);
    const tail = open.text.slice(cut + 1);
    col.setText(open, head);
    col.finalize(open);
    open = col.newLine(tMs);
    linesThisRun++;
    col.setText(open, tail.replace(/^\s+/, ''));
  }

  return {
    append(delta, tMs) {
      if (!delta) return;
      if (!open) { open = col.newLine(tMs); linesThisRun++; }
      col.setText(open, open.text + delta);
      clearTimers();

      // Split off every sentence the incoming text has completed.
      for (let cut = sentenceCut(open.text); cut > 0; cut = sentenceCut(open.text)) {
        const tail = open.text.slice(cut).replace(/^\s+/, '');
        col.setText(open, open.text.slice(0, cut));
        col.finalize(open);
        open = col.newLine(tMs);
        linesThisRun++;
        col.setText(open, tail);
      }

      // Timers now only cover the trailing sentence, which has no text after
      // it to prove it is finished.
      if (PUNCT_END.test(open.text)) punctTimer = setTimeout(flush, PUNCT_FLUSH_MS);
      gapTimer = setTimeout(flush, GAP_FLUSH_MS);
      softSplit(tMs);
    },
    /**
     * Authoritative text for a whole item. Only safe to substitute when this
     * run produced a single line; once we have split it across several, the
     * earlier text is already on screen and replacing would duplicate it.
     */
    settle(text, tMs) {
      if (linesThisRun <= 1 && text) {
        if (!open) { open = col.newLine(tMs); }
        col.setText(open, text);
      }
      flush();
      linesThisRun = 0;
    },
    startRun() { flush(); linesThisRun = 0; },
    flush,
    reset() { clearTimers(); open = null; linesThisRun = 0; col.clear(); },
  };
}

/**
 * Target column. session.output_transcript.delta is append-only with no item
 * ids and no completion event, so segmentation is entirely local.
 */
export function createTargetStream(container) {
  const col = createColumn(container);
  const seg = segmenter(col);
  return Object.assign({}, col, {
    apply({ delta }, tMs) { seg.append(delta, tMs); },
    flush: seg.flush,
    reset: seg.reset,
  });
}

/**
 * Source column. Segments locally like the target, but additionally starts a
 * fresh run whenever a new item_id appears and honours .completed when one
 * arrives (which only happens if the buffer is explicitly committed).
 */
export function createSourceStream(container) {
  const col = createColumn(container);
  const seg = segmenter(col);
  let currentItem = null;

  return Object.assign({}, col, {
    apply({ itemId, delta, text, final }, tMs) {
      if (itemId && itemId !== currentItem) {
        seg.startRun();
        currentItem = itemId;
      }
      if (final) {
        seg.settle(text, tMs);
        currentItem = null;
      } else {
        seg.append(delta, tMs);
      }
    },
    flush: seg.flush,
    reset() { currentItem = null; seg.reset(); },
  });
}
