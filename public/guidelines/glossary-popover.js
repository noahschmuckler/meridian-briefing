// ------------------------------------------------------------------
// Glossary popover — definition-on-click for decorated `.glossary-term`
// spans. App-level component: listens for clicks on any decorated term
// inside the guidelines surface, resolves it against the merged glossary,
// and floats a dark-glass card with expansion + definition. Dismiss on
// Esc / scroll / outside click. (Mirrors meridian-os GlossaryPopover, but
// self-contained — no signals, no pop-out-to-bubble action in v1.)
// ------------------------------------------------------------------

import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { findGlossaryEntry } from './decorate.js';

const html = htm.bind(h);

export function GlossaryPopover({ entries }) {
  const [state, setState] = useState(null); // { entry, rect }
  const ref = useRef(null);

  useEffect(() => {
    function onClick(e) {
      const term = e.target.closest && e.target.closest('.glossary-term');
      if (term) {
        e.preventDefault();
        e.stopPropagation();
        const entry = findGlossaryEntry(term.dataset.term, entries);
        if (entry) {
          setState({ entry, rect: term.getBoundingClientRect() });
          return;
        }
      }
      // Click anywhere else (and not inside the popover) dismisses.
      if (ref.current && !ref.current.contains(e.target)) setState(null);
    }
    function onKey(e) { if (e.key === 'Escape') setState(null); }
    function onScroll() { setState(null); }
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [entries]);

  if (!state) return null;

  // Place above by default; flip below if too close to the top; clamp x.
  const { rect } = state;
  const W = 300;
  const flipBelow = rect.top < 180;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 8));
  const style = flipBelow
    ? { left: `${left}px`, top: `${rect.bottom + 8}px` }
    : { left: `${left}px`, bottom: `${window.innerHeight - rect.top + 8}px` };

  const { entry } = state;
  return html`<div ref=${ref} class="guidelines-glossary-popover" style=${style}>
    <div class="guidelines-glossary-popover__term">
      ${entry.term}${entry.expansion ? html`<span class="guidelines-glossary-popover__exp"> — ${entry.expansion}</span>` : null}
    </div>
    <div class="guidelines-glossary-popover__def">${entry.definition}</div>
  </div>`;
}
