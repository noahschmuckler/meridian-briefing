// ------------------------------------------------------------------
// PainPoints — GENERIC renderer for a gated internal "explainer" artifact.
//
// This file is committed and carries NO sensitive content. All prose lives in
// data/artifacts/painpoints.json (gitignored, placed per-box like .env) and is
// fetched from the admin-session-gated GET /api/admin/artifacts/painpoints.
//
// Schema it renders:
//   { header:{eyebrow,flag,title,titleAccent,subtitle},
//     sections:[{id,label,icon,title, cards?:[{accent,title,html}], render?:'todos'}],
//     todos:[{priority,owner,deadline,task,detail}] }
// Card `html` is trusted (author-controlled, gated) and rendered as-is.
// ------------------------------------------------------------------

import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

const PRIORITIES = ['ALL', 'URGENT', 'HIGH', 'MEDIUM', 'LOWER'];

function Card({ card }) {
  return html`<div class="pp-card">
    <div class=${'pp-card-title pp-' + (card.accent || 'accent')}>${card.title}</div>
    <div class="pp-card-body" dangerouslySetInnerHTML=${{ __html: card.html || '' }}></div>
  </div>`;
}

function Todos({ todos }) {
  const [filter, setFilter] = useState('ALL');
  const [open, setOpen] = useState(null);
  const list = filter === 'ALL' ? todos : todos.filter((t) => t.priority === filter);

  return html`<${Fragment}>
    <div class="pp-todo-filters">
      ${PRIORITIES.map(
        (f) => html`<button
          type="button"
          class=${'pp-todo-filter' + (filter === f ? ' is-active pp-prio-' + f.toLowerCase() : '')}
          onClick=${() => setFilter(f)}
        >${f}</button>`,
      )}
    </div>
    <div class="pp-todo-list">
      ${list.map(
        (t, i) => html`<div
          key=${i}
          class=${'pp-todo pp-prio-edge-' + t.priority.toLowerCase() + (open === i ? ' is-open' : '')}
          onClick=${() => setOpen(open === i ? null : i)}
        >
          <div class="pp-todo-meta">
            <span class=${'pp-todo-prio pp-prio-' + t.priority.toLowerCase()}>${t.priority}</span>
            <span class="pp-todo-deadline">${t.deadline}</span>
            <span class="pp-todo-owner">${t.owner}</span>
          </div>
          <div class="pp-todo-main">
            <div class="pp-todo-task">${t.task}</div>
            ${open === i && html`<div class="pp-todo-detail">${t.detail}</div>`}
          </div>
          <div class="pp-todo-caret">${open === i ? '▲' : '▼'}</div>
        </div>`,
      )}
    </div>
  <//>`;
}

export function PainPoints({ onBack }) {
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState(null);
  const [active, setActive] = useState(null);

  useEffect(() => {
    fetch('/api/admin/artifacts/painpoints', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        setDoc(d);
        setActive((d.sections && d.sections[0] && d.sections[0].id) || null);
      })
      .catch((s) => setErr(s === 401 ? 'auth' : 'missing'));
    // Best-effort open beacon (reuses the existing 'area' usage type).
    try {
      if (window.mbTrack) window.mbTrack('area', { area: 'artifact:painpoints' });
    } catch {
      /* ignore */
    }
  }, []);

  const back = html`<button type="button" class="pp-back" onClick=${onBack}>‹ meridian</button>`;

  if (err === 'auth') {
    return html`<div class="painpoints painpoints--status">
      ${back}
      <p>Your session expired. <a href="/admin">Sign in again</a>.</p>
    </div>`;
  }
  if (err) {
    return html`<div class="painpoints painpoints--status">
      ${back}
      <p>This artifact isn't provisioned on this server.</p>
      <p class="pp-status-hint"><code>data/artifacts/painpoints.json</code> is a per-box file, placed like <code>.env</code>.</p>
    </div>`;
  }
  if (!doc) return html`<div class="painpoints painpoints--status">${back}<p>Loading…</p></div>`;

  const section = doc.sections.find((s) => s.id === active) || doc.sections[0];

  return html`<div class="painpoints">
    ${back}
    <div class="pp-header">
      <div class="pp-header-tags">
        <span class="pp-eyebrow">${doc.header.eyebrow}</span>
        <span class="pp-flag">${doc.header.flag}</span>
      </div>
      <h1 class="pp-title">${doc.header.title}<span class="pp-title-accent">${doc.header.titleAccent}</span></h1>
      <div class="pp-subtitle">${doc.header.subtitle}</div>
    </div>
    <div class="pp-body">
      <nav class="pp-sidebar">
        ${doc.sections.map(
          (s) => html`<button
            type="button"
            class=${'pp-nav' + (s.id === active ? ' is-active' : '')}
            onClick=${() => setActive(s.id)}
          ><span class="pp-nav-icon">${s.icon}</span>${s.label}</button>`,
        )}
      </nav>
      <main class="pp-main">
        <h2 class="pp-section-title">${section.title}</h2>
        ${section.render === 'todos'
          ? html`<${Todos} todos=${doc.todos || []} />`
          : html`<div class="pp-cards">${(section.cards || []).map((c) => html`<${Card} card=${c} />`)}</div>`}
      </main>
    </div>
  </div>`;
}
