// ------------------------------------------------------------------
// Clinical Guidelines — the three core "bubbles" (green checklist /
// red escalation / blue detail) + the shared row, ported from
// meridian-os src/bubbles/clinical-module-{checklist,escalations,faq}.
//
// meridian-os coordinates these via @preact/signals (moduleFocusSignal);
// here the whole experience is one tree, so the parent (GuidelinesApp)
// owns `focusedFaqId` and passes it + callbacks down. Dropped vs source:
// .docx/.pptx export, FontSizeControls, and (PR2) the consult-mention
// decoration + the green-zone "All SmartPhrases →" launch.
// ------------------------------------------------------------------

import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import {
  stripRefMarkers,
  expandRefMarkers,
  getModuleRefNumberer,
  getReferencesUsedIn,
  decorateGlossaryText,
  decorateGlossaryHtml,
  getMergedGlossary,
} from './decorate.js';

const html = htm.bind(h);

// Per-type accent — mirrors the t-clinical-module-* --type-color values in
// meridian-os glass.css.
export const TYPE_COLOR = {
  checklist: '#0F6B42',
  escalation: '#d92e2e',
  faq: '#1f4cae',
  prevent: '#f4c020',
};

// ---- shared row -----------------------------------------------------------

function ModuleRow({ statement, marker, markerShape, focused, onClick }) {
  return html`<button
    type="button"
    class=${'cm-row' + (focused ? ' cm-row--focused' : '')}
    onClick=${(e) => { e.stopPropagation(); onClick(); }}
  >
    <span class=${'cm-row__marker' + (markerShape === 'circle' ? ' cm-row__marker--circle' : '')}>${marker}</span>
    <span>${statement}</span>
  </button>`;
}

// ---- green checklist ------------------------------------------------------

export function ChecklistBubble({ module, glossary, focusedFaqId, onPickRow }) {
  const merged = getMergedGlossary(module, glossary);
  const decorate = (text) => decorateGlossaryText(stripRefMarkers(text), merged);
  const intro = decorate(module.landing_intro);
  const contextHtml = module.context_strip ? decorate(module.context_strip.text) : '';
  const footerHtml = module.footer_note ? decorate(module.footer_note) : '';

  return html`<div class="cm-bubble" style=${{ '--type-color': TYPE_COLOR.checklist }}>
    <div class="bubble__chrome">
      <span class="bubble__title" style="color:var(--type-color);font-size:12px">${module.default_title}</span>
      <span class="cm-chrome-meta">${module.checklist.length} checks</span>
    </div>
    <div class="bubble__body">
      <p class="cm-intro" dangerouslySetInnerHTML=${{ __html: intro }}></p>
      <div style="margin-bottom:12px">
        <div class="cm-section-label">${module.checklist_section_label}</div>
        <div class="cm-rows">
          ${module.checklist.map((item) => html`<${ModuleRow}
            key=${item.item_id}
            statement=${item.statement}
            marker=${String(item.position)}
            markerShape="square"
            focused=${focusedFaqId === item.faq_ref}
            onClick=${() => onPickRow(item.faq_ref)}
          />`)}
        </div>
      </div>
      <div class="cm-greenzone">
        <div class="cm-greenzone__label">
          ✓ ${module.green_zone.zone_label}
          ${module.green_zone.smartphrase && html`<${GreenZoneSmartphrase} module=${module} />`}
        </div>
        ${module.context_strip && html`<div class="cm-context">
          <strong>${module.context_strip.label}: </strong>
          <span dangerouslySetInnerHTML=${{ __html: contextHtml }}></span>
        </div>`}
        ${module.footer_note && html`<div class="cm-footer-note" dangerouslySetInnerHTML=${{ __html: footerHtml }}></div>`}
      </div>
    </div>
  </div>`;
}

// Green-zone continuation phrase as a click-to-copy chip (copies the full
// registry text). PR1: copy chip only; the "All SmartPhrases →" launch lands
// with the selector bubble in PR2.
function GreenZoneSmartphrase({ module }) {
  const [copied, setCopied] = useState(false);
  const trigger = module.green_zone.smartphrase;
  const phrase = (module.smartphrases || []).find((s) => s.id === trigger);

  async function copyPhrase() {
    if (!phrase || !phrase.text) return;
    try {
      await navigator.clipboard.writeText(phrase.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch { /* clipboard denied */ }
  }

  return html`<button
    type="button"
    class=${'cm-sp-chip' + (copied ? ' cm-sp-chip--copied' : '')}
    title=${phrase && phrase.text ? 'Copy SmartPhrase text' : trigger}
    onClick=${(e) => { e.stopPropagation(); copyPhrase(); }}
    disabled=${!(phrase && phrase.text)}
  >${copied ? 'Copied' : trigger}</button>`;
}

// ---- red escalations ------------------------------------------------------

export function EscalationBubble({ module, focusedFaqId, onPickRow }) {
  return html`<div class="cm-bubble" style=${{ '--type-color': TYPE_COLOR.escalation }}>
    <div class="bubble__chrome">
      <span class="bubble__title" style="color:var(--type-color)">${module.escalation_section_label}</span>
      <span class="cm-chrome-meta">${module.escalation.length} triggers</span>
    </div>
    <div class="bubble__body">
      <div class="cm-rows">
        ${module.escalation.map((item) => html`<${ModuleRow}
          key=${item.item_id}
          statement=${item.statement}
          marker="!"
          markerShape="circle"
          focused=${focusedFaqId === item.faq_ref}
          onClick=${() => onPickRow(item.faq_ref)}
        />`)}
      </div>
    </div>
  </div>`;
}

// ---- blue detail / FAQ ----------------------------------------------------

export function FaqBubble({ module, glossary, focusedFaqId, onPickFaq, onClearFocus }) {
  const focusedFaq = focusedFaqId ? (module.faqs || []).find((f) => f.faq_id === focusedFaqId) : null;

  return html`<div class="cm-faq" style=${{ '--type-color': TYPE_COLOR.faq }}>
    <div class="bubble__chrome">
      ${focusedFaq && html`<button
        type="button"
        class="cm-faq__back"
        title="Back to all topics"
        aria-label="Back to all topics"
        onClick=${(e) => { e.stopPropagation(); onClearFocus(); }}
      ><span class="cm-faq__back-chevron">‹</span><span class="cm-faq__back-label">topics</span></button>`}
      <span class="bubble__title">${focusedFaq ? focusedFaq.topic : `${module.default_title.split(' — ')[0]} · detail`}</span>
      ${focusedFaq && html`<span class="cm-chrome-meta">${(focusedFaq.sub_questions ? focusedFaq.sub_questions.length : (focusedFaq.items ? focusedFaq.items.length : 0))} Q</span>`}
    </div>
    <div class="bubble__body">
      ${focusedFaq
        ? html`<${FocusedFaq} key=${focusedFaq.faq_id} entry=${focusedFaq} module=${module} glossary=${glossary} />`
        : html`<${IdleIndex} faqs=${module.faqs || []} onPick=${onPickFaq} />`}
    </div>
  </div>`;
}

function FocusedFaq({ entry, module, glossary }) {
  const numberer = getModuleRefNumberer(module);
  const merged = getMergedGlossary(module, glossary);
  // PR1 decorate chain: expand ref markers, then glossary. (Consult-mention
  // decoration joins this chain in PR2 with the consult builder.)
  const decorate = (h0) => decorateGlossaryHtml(expandRefMarkers(h0, module, numberer), merged);

  const isTwoTier = typeof entry.first_layer_html === 'string' && entry.first_layer_html.length > 0;
  const renderedHtmls = isTwoTier
    ? [entry.first_layer_html || '', ...((entry.sub_questions || []).map((qa) => qa.answer_html))]
    : ((entry.items || []).map((qa) => qa.answer_html));
  const cited = getReferencesUsedIn(renderedHtmls, module, numberer);

  const checklistIds = new Set(module.checklist.map((c) => c.item_id));
  const escalationIds = new Set(module.escalation.map((e) => e.item_id));
  const refs = entry.referenced_by || [];
  const isChecklist = refs.some((r) => checklistIds.has(r));
  const isEscalation = refs.some((r) => escalationIds.has(r));

  return html`<div>
    <div class="cm-faq__badges">
      ${isChecklist && html`<span class="cm-faq__badge cm-faq__badge--checklist">Checklist</span>`}
      ${isEscalation && html`<span class="cm-faq__badge cm-faq__badge--escalation">Escalation</span>`}
      ${!isChecklist && !isEscalation && refs.length === 0 && html`<span class="cm-faq__badge cm-faq__badge--neutral">Reference</span>`}
    </div>
    <h3 class="cm-faq__title">${entry.title}</h3>
    ${isTwoTier
      ? html`<${TwoTierBody} entry=${entry} decorate=${decorate} module=${module} />`
      : html`<${LegacyItemsBody} items=${entry.items || []} decorate=${decorate} />`}
    ${cited.length > 0 && html`<ol class="faq-references">
      ${cited.map(({ number, ref }) => html`<li key=${ref.ref_id} id=${`ref-${ref.ref_id}`} value=${number}>
        ${ref.url
          ? html`<a href=${ref.url} target="_blank" rel="noopener noreferrer">${ref.citation}</a>`
          : html`<span>${ref.citation}</span>`}
      </li>`)}
    </ol>`}
  </div>`;
}

function TwoTierBody({ entry, decorate, module }) {
  const subQuestions = entry.sub_questions || [];
  return html`<div>
    <div
      class="markdown-body cm-faq__first-layer"
      dangerouslySetInnerHTML=${{ __html: decorate(entry.first_layer_html || '') }}
    ></div>
    ${entry.smartphrase_note && html`<${SmartPhraseNotePill} note=${entry.smartphrase_note} module=${module} />`}
    ${entry.consult_decision_point && html`<${ConsultDecisionPointPill} point=${entry.consult_decision_point} />`}
    ${subQuestions.length > 0 && html`<div style="margin-top:14px">
      <div class="cm-faq__more-label">More detail</div>
      <div class="cm-faq__subq-list">
        ${subQuestions.map((qa, i) => html`<${SubQuestionRow} key=${i} qa=${qa} decorate=${decorate} />`)}
      </div>
    </div>`}
  </div>`;
}

function LegacyItemsBody({ items, decorate }) {
  return html`<div class="cm-faq__legacy">
    ${items.map((qa, i) => html`<div key=${i}>
      <div class="cm-faq__legacy-q">${qa.question}</div>
      <div class="markdown-body cm-faq__legacy-a" dangerouslySetInnerHTML=${{ __html: decorate(qa.answer_html) }}></div>
    </div>`)}
  </div>`;
}

function SubQuestionRow({ qa, decorate }) {
  const [open, setOpen] = useState(false);
  return html`<div class="cm-faq__subq">
    <button type="button" aria-expanded=${open} class="cm-faq__subq-btn" onClick=${(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <span style="flex:1">${qa.question}</span>
      <span class=${'cm-caret' + (open ? ' cm-caret--open' : '')}>▾</span>
    </button>
    ${open && html`<div class="markdown-body cm-faq__subq-a" dangerouslySetInnerHTML=${{ __html: decorate(qa.answer_html) }}></div>`}
  </div>`;
}

function ConsultDecisionPointPill({ point }) {
  const [open, setOpen] = useState(false);
  return html`<div class="cm-faq__consult-dp">
    <button type="button" aria-expanded=${open} class="cm-faq__consult-dp-btn" onClick=${(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <span>Consult decision point</span>
      ${point.trigger_label && html`<span class="cm-faq__consult-dp-label">· ${point.trigger_label}</span>`}
      <span class=${'cm-caret' + (open ? ' cm-caret--open' : '')}>▾</span>
    </button>
    ${open && html`<div class="cm-faq__consult-dp-body">${point.prefill_text}</div>`}
  </div>`;
}

function SmartPhraseNotePill({ note, module }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerMatch = note.match(/(\.[A-Z0-9-]+)/);
  const trigger = triggerMatch ? triggerMatch[1] : null;
  const phrase = trigger ? (module.smartphrases || []).find((s) => s.id === trigger) : undefined;

  if (!phrase || !phrase.text) {
    return html`<div class="cm-faq__sp-note">
      <span class="cm-faq__sp-pill">SmartPhrase</span>
      <span class="cm-faq__sp-note-text">${note}</span>
    </div>`;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(phrase.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch { /* clipboard denied */ }
  }

  return html`<div class="cm-faq__sp-note cm-faq__sp-note--block">
    <button type="button" aria-expanded=${open} class="cm-faq__sp-btn" onClick=${(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <span class="cm-faq__sp-pill">SmartPhrase</span>
      <code class="cm-faq__sp-code">${phrase.id}</code>
      ${phrase.status === 'future' && html`<span class="cm-faq__sp-future">future</span>`}
      <span class=${'cm-caret' + (open ? ' cm-caret--open' : '')}>▾</span>
    </button>
    ${open && html`<div class="cm-faq__sp-expand">
      <div class="cm-faq__sp-text">${phrase.text}</div>
      <button type="button" class=${'cm-copy-btn' + (copied ? ' cm-copy-btn--copied' : '')} onClick=${(e) => { e.stopPropagation(); copy(); }}>
        ${copied ? 'Copied' : 'Copy SmartPhrase'}
      </button>
    </div>`}
  </div>`;
}

function IdleIndex({ faqs, onPick }) {
  return html`<div>
    <p class="cm-faq__idle-hint">Tap a checklist or escalation item to see its detail — or pick a topic below.</p>
    <div class="cm-faq__idle-list">
      ${faqs.map((f) => html`<button key=${f.faq_id} type="button" class="cm-faq__idle-item" onClick=${(e) => { e.stopPropagation(); onPick(f.faq_id); }}>
        <div class="cm-faq__idle-topic">${f.topic}</div>
        <div class="cm-faq__idle-title">${f.title}</div>
      </button>`)}
    </div>
  </div>`;
}
