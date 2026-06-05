// ------------------------------------------------------------------
// Clinical Guidelines app — launched from the meridian home tile (public
// /home and authed /admin alike) via the /guidelines route. Goes straight
// to a flat selection of all 7 modules (no gallery / topic / archive), then
// each module opens to the 3-bubble reading view (green checklist / red
// escalation / blue detail), with PREVENT shown by default for lipid.
//
// One component tree owns all state (selected module + focused FAQ) — no
// signals. Module content is fetched as static JSON from public/.
// ------------------------------------------------------------------

import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import htm from 'htm';

import { ChecklistBubble, EscalationBubble, FaqBubble } from './bubbles.js';
import { PreventCalculator } from './prevent.js';
import { GlossaryPopover } from './glossary-popover.js';
import { getMergedGlossary, stripRefMarkers } from './decorate.js';

const html = htm.bind(h);

// Modules marked draft (the schema-1.0.x entries not yet through the
// evidence/simplification passes). Shown with a Draft badge; still openable.
const DRAFT_IDS = new Set(['anemia', 'abd-pain', 'ckd']);
// Modules whose default view includes the PREVENT calculator panel.
const PREVENT_MODULES = new Set(['lipid-management']);

// Selection-card order. The grid flows column-first over 3 rows (see
// guidelines.css), so this array lays out as: left column = the three
// inherited-patient controlled-substance modules, grouped; top-middle =
// lipid; the remaining three (ckd / anemia / abd-pain) fill the rest in no
// particular order. Ids not listed sort to the end.
const MODULE_ORDER = ['adhd', 'opiates', 'benzos', 'lipid-management', 'ckd', 'anemia', 'abd-pain'];
function moduleOrder(id) {
  const i = MODULE_ORDER.indexOf(id);
  return i === -1 ? MODULE_ORDER.length : i;
}

function go(path) { window.location.assign(path); }

function backToHome() {
  // Return to whichever home (/home or /admin) the user came from.
  if (window.history.length > 1) window.history.back();
  else go('/home');
}

// ---- data (fetched once, cached at module scope) --------------------------
let dataPromise = null;
function loadData() {
  if (!dataPromise) {
    dataPromise = Promise.all([
      fetch('/guidelines/data/clinical-modules.json').then((r) => r.json()),
      fetch('/guidelines/data/glossary.json').then((r) => r.json()),
    ]).then(([modulesDoc, glossaryDoc]) => ({
      modules: (modulesDoc && modulesDoc.clinical && modulesDoc.clinical.modules) || [],
      glossary: (glossaryDoc && glossaryDoc.glossary && glossaryDoc.glossary.global) || [],
    }));
  }
  return dataPromise;
}

function plainSnippet(text, max) {
  const div = document.createElement('div');
  div.innerHTML = stripRefMarkers(text || '');
  const plain = (div.textContent || '').trim();
  return plain.length > max ? plain.slice(0, max).replace(/\s+\S*$/, '') + '…' : plain;
}

export function GuidelinesApp() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [focusedFaqId, setFocusedFaqId] = useState(null);

  useEffect(() => {
    let alive = true;
    loadData().then(
      (d) => { if (alive) setData(d); },
      () => { if (alive) setError('Could not load clinical modules.'); },
    );
    return () => { alive = false; };
  }, []);

  const selected = useMemo(
    () => (data && selectedId ? data.modules.find((m) => m.module_id === selectedId) : null),
    [data, selectedId],
  );

  const mergedGlossary = useMemo(
    () => (data ? getMergedGlossary(selected, data.glossary) : []),
    [data, selected],
  );

  function openModule(id) {
    setSelectedId(id);
    setFocusedFaqId(null);
  }
  function backToSelection() {
    setSelectedId(null);
    setFocusedFaqId(null);
  }

  if (error) {
    return html`<div class="guidelines-app"><div class="guidelines-status guidelines-status--error">${error}</div></div>`;
  }
  if (!data) {
    return html`<div class="guidelines-app"><div class="guidelines-status">Loading clinical modules…</div></div>`;
  }

  if (!selected) {
    return html`<${Selection} modules=${data.modules} onOpen=${openModule} />`;
  }

  const showPrevent = PREVENT_MODULES.has(selected.module_id);
  return html`<div class="guidelines-app">
    <div class="guidelines-bar">
      <button type="button" class="guidelines-bar__back" onClick=${backToHome} title="Back to meridian">‹ meridian</button>
      <button type="button" class="guidelines-bar__back" onClick=${backToSelection} title="All modules">‹ modules</button>
      <span class="guidelines-bar__title">${selected.default_title}</span>
      ${DRAFT_IDS.has(selected.module_id) && html`<span class="guidelines-draft-badge">Draft</span>`}
    </div>
    <div class=${'cm-layout' + (showPrevent ? ' cm-layout--with-panel' : '')}>
      <div class="cm-layout__left">
        <${ChecklistBubble} module=${selected} glossary=${data.glossary} focusedFaqId=${focusedFaqId} onPickRow=${setFocusedFaqId} />
        <${EscalationBubble} module=${selected} focusedFaqId=${focusedFaqId} onPickRow=${setFocusedFaqId} />
      </div>
      <div class="cm-layout__center">
        <${FaqBubble} module=${selected} glossary=${data.glossary} focusedFaqId=${focusedFaqId} onPickFaq=${setFocusedFaqId} onClearFocus=${() => setFocusedFaqId(null)} />
      </div>
      ${showPrevent && html`<div class="cm-layout__panel"><${PreventCalculator} /></div>`}
    </div>
    <${GlossaryPopover} entries=${mergedGlossary} />
  </div>`;
}

function Selection({ modules, onOpen }) {
  return html`<div class="guidelines-app">
    <div class="guidelines-bar">
      <button type="button" class="guidelines-bar__back" onClick=${backToHome} title="Back to meridian">‹ meridian</button>
      <span class="guidelines-bar__title">Clinical Guidelines</span>
    </div>
    <div class="guidelines-select">
      <div class="guidelines-select__intro">Select a clinical module.</div>
      <div class="guidelines-select__grid">
        ${[...modules].sort((a, b) => moduleOrder(a.module_id) - moduleOrder(b.module_id)).map((m) => html`<button key=${m.module_id} type="button" class="guidelines-card" onClick=${() => onOpen(m.module_id)}>
          <div class="guidelines-card__head">
            <span class="guidelines-card__title">${m.default_title}</span>
            ${DRAFT_IDS.has(m.module_id) && html`<span class="guidelines-draft-badge">Draft</span>`}
          </div>
          <div class="guidelines-card__snippet">${plainSnippet(m.landing_intro, 180)}</div>
        </button>`)}
      </div>
    </div>
  </div>`;
}
