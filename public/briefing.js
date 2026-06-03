// ------------------------------------------------------------------
// meridian-briefing — front-end (Preact + htm, vendored; no build step).
//
// Two modes off one component tree:
//   /        → ReadApp:  fetch /api/editions/current, render read-only.
//   /admin   → AdminApp: login gate → Editor that renders the SAME <Briefing>
//              with `edit` handlers wired (contentEditable text, enum dropdowns,
//              icon picker, structural add/remove/reorder), debounced PATCH save,
//              edition picker, +New draft, publish toggle.
//
// The <Briefing> component is the single renderer; `edit` being null vs an
// object is the only difference between the provider view and the editor.
// ------------------------------------------------------------------

import { h, render, Fragment } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

// ---- enum vocabularies (mirror lib/store.js) ----
const LEFT_TINTS = ['teal', 'coral', 'sage', 'lavender'];
const TOP_TINTS = ['sky', 'gold', 'warm'];
const DOTS = ['green', 'yellow', 'blue', 'purple'];
const TOP_AREAS = ['top-b1', 'top-b2', 'top-b3'];
const ICONS = [
  '📋', '🩺', '🔬', '💊', '📅', '💻', '🌐', '📈',
  '📊', '🏥', '🧪', '🫀', '🧠', '🦴', '👁️', '🩹',
  '📣', '⚠️', '✅', '📝', '🔔', '💡', '📌', '🗓️',
  '🧾', '💉', '🩻', '🧬', '⭐', '🎯', '📂', '🔒',
];

// ---- tiny helpers ----
async function api(path, opts) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  return { ok: res.ok, status: res.status, body };
}

// Immutable set-in by path, e.g. setIn(ed, ['leftAdvisories', 2, 'headline'], v).
function setIn(obj, path, value) {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const clone = Array.isArray(obj) ? obj.slice() : { ...obj };
  clone[head] = setIn(obj ? obj[head] : undefined, rest, value);
  return clone;
}

// ════════════════════════════════════════════════════════════════════
// Shared field primitives
// ════════════════════════════════════════════════════════════════════

function EditableText({ value, multiline, onCommit, className }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.textContent = value || '';
  }, [value]);

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const text = el.textContent.replace(/\u00a0/g, ' '); // contentEditable injects NBSPs
    if (text !== (value || '')) onCommit(text);
  };

  return html`<span
    ref=${ref}
    class=${'editable ' + (className || '')}
    contentEditable=${'true'}
    spellcheck=${'false'}
    onBlur=${commit}
    onKeyDown=${(e) => {
      if (e.key === 'Enter' && !e.shiftKey && !multiline) {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.currentTarget.textContent = value || '';
        e.currentTarget.blur();
      }
    }}
    onPaste=${(e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    }}
  ></span>`;
}

// Read-mode plain text vs edit-mode contentEditable, chosen by `edit`.
function Field({ edit, path, value, multiline, className }) {
  if (!edit) return html`<${Fragment}>${value}<//>`;
  return html`<${EditableText}
    value=${value}
    multiline=${multiline}
    className=${className}
    onCommit=${(v) => edit.onEdit(path, v)}
  />`;
}

function EnumSelect({ value, options, onChange }) {
  return html`<select
    class="mini-select"
    value=${value}
    onChange=${(e) => onChange(e.currentTarget.value)}
    onClick=${(e) => e.stopPropagation()}
  >
    ${options.map((o) => html`<option value=${o} selected=${o === value}>${o}</option>`)}
  </select>`;
}

function IconField({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return html`<span ref=${wrapRef} style="position:relative; display:inline-block;">
    <button type="button" class="icon-btn" onClick=${() => setOpen((o) => !o)}>${value || '＋'}</button>
    ${open &&
    html`<div class="icon-popover">
      <div class="icon-grid">
        ${ICONS.map(
          (ic) => html`<button type="button" onClick=${() => {
            onChange(ic);
            setOpen(false);
          }}>${ic}</button>`,
        )}
      </div>
      <input
        type="text"
        placeholder="or type one…"
        value=${value}
        onInput=${(e) => onChange(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') setOpen(false);
        }}
      />
    </div>`}
  </span>`;
}

// ════════════════════════════════════════════════════════════════════
// <Briefing> — the single renderer (read + admin)
// ════════════════════════════════════════════════════════════════════

function Briefing({ edition, layout, setLayout, expanded, setExpanded, edit, dateMenu }) {
  const ed = edition;
  const leftTints = LEFT_TINTS;

  const cardTools = (listKey, idx, len) =>
    edit &&
    html`<div class="card-tools">
      ${len > 1 && html`<button type="button" class="tool-btn danger" title="Delete" onClick=${(e) => {
        e.stopPropagation();
        edit.removeItem(listKey, idx);
      }}>×</button>`}
    </div>`;

  return html`<div class=${'briefing-app' + (edit ? ' admin-mode' : '')}>
    ${!edit &&
    html`<div class="orientation-bar">
      <div class="orientation-bar__left">
        <span class="orientation-bar__badge">Meridian</span>
        <span>Crystal Run Healthcare · Primary &amp; Urgent Care · Provider Briefing</span>
      </div>
      <div class="orientation-bar__right">
        <span class="orientation-bar__layout-label">Layout:</span>
        <div class="toggle-group">
          <button type="button" class=${'toggle-btn' + (layout === 'landscape' ? ' active' : '')} onClick=${() => setLayout('landscape')}>Landscape</button>
          <button type="button" class=${'toggle-btn' + (layout === 'portrait' ? ' active' : '')} onClick=${() => setLayout('portrait')}>Portrait</button>
        </div>
      </div>
    </div>`}

    <div class=${'page-wrapper' + (layout === 'portrait' ? ' portrait-mode' : '')}>
      <div class="masthead">
        <div class="masthead-left">
          <div class="masthead-title">Provider Briefing</div>
          <div class="masthead-subtitle">Primary &amp; Urgent Care · Optum NY/NJ</div>
        </div>
        <div class="masthead-meta">
          ${edit
            ? html`<${Fragment}>
                <strong><${Field} edit=${edit} path=${['issue', 'masthead_label']} value=${ed.issue.masthead_label} /></strong><br />
                <${Field} edit=${edit} path=${['issue', 'issue_label']} value=${ed.issue.issue_label} />
              <//>`
            : dateMenu
              ? html`<${Fragment}>
                  <button type="button" class="masthead-date-btn" onClick=${dateMenu.toggle}>${ed.issue.masthead_label || ed.date}</button>
                  <br />${ed.issue.issue_label}
                  ${dateMenu.open && html`<div class="date-menu">
                    ${dateMenu.items.length === 0 && html`<div class="date-menu-item">No other editions</div>`}
                    ${dateMenu.items.map(
                      (it) => html`<button
                        type="button"
                        class=${'date-menu-item' + (it.id === ed.id ? ' active' : '')}
                        onClick=${() => dateMenu.select(it.id)}
                      >${it.title}<small>${it.date}</small></button>`,
                    )}
                  </div>`}
                <//>`
              : html`<${Fragment}><strong>${ed.issue.masthead_label}</strong><br />${ed.issue.issue_label}<//>`}
        </div>
      </div>

      <div class=${'briefing-grid ' + layout}>
        <div class="left-bubbles">
          ${ed.leftAdvisories.map(
            (b, i) => html`<div key=${i} class=${'brief-card brief-card-' + (leftTints.includes(b.tint) ? b.tint : 'teal')}>
              ${cardTools('leftAdvisories', i, ed.leftAdvisories.length)}
              ${edit
                ? html`<${IconField} value=${b.icon} onChange=${(v) => edit.onEdit(['leftAdvisories', i, 'icon'], v)} />`
                : html`<div class="brief-card-icon">${b.icon}</div>`}
              <div class="brief-card-headline"><${Field} edit=${edit} path=${['leftAdvisories', i, 'headline']} value=${b.headline} /></div>
              <div class="brief-card-body"><${Field} edit=${edit} path=${['leftAdvisories', i, 'body']} value=${b.body} multiline=${true} /></div>
              <span class="brief-card-tag"><${Field} edit=${edit} path=${['leftAdvisories', i, 'tag']} value=${b.tag} /></span>
              ${edit && html`<div class="field-row">
                <${EnumSelect} value=${b.tint} options=${LEFT_TINTS} onChange=${(v) => edit.onEdit(['leftAdvisories', i, 'tint'], v)} />
              </div>`}
            </div>`,
          )}
          ${edit && html`<button type="button" class="add-row-btn" onClick=${() => edit.addItem('leftAdvisories')}>+ Add advisory</button>`}
        </div>

        <div class="right-side">
          <div class="top-bubbles">
            ${ed.topEvents.map(
              (b, i) => html`<div key=${i} class=${'brief-card top-bubble brief-card-' + (TOP_TINTS.includes(b.tint) ? b.tint : 'sky')}>
                ${cardTools('topEvents', i, ed.topEvents.length)}
                ${edit
                  ? html`<${IconField} value=${b.icon} onChange=${(v) => edit.onEdit(['topEvents', i, 'icon'], v)} />`
                  : html`<div class="brief-card-icon">${b.icon}</div>`}
                <div class="brief-card-headline"><${Field} edit=${edit} path=${['topEvents', i, 'headline']} value=${b.headline} /></div>
                <div class="brief-card-body"><${Field} edit=${edit} path=${['topEvents', i, 'body']} value=${b.body} multiline=${true} /></div>
                <span class="brief-card-tag"><${Field} edit=${edit} path=${['topEvents', i, 'tag']} value=${b.tag} /></span>
                ${edit && html`<div class="field-row">
                  <${EnumSelect} value=${b.tint} options=${TOP_TINTS} onChange=${(v) => edit.onEdit(['topEvents', i, 'tint'], v)} />
                  <${EnumSelect} value=${b.area} options=${TOP_AREAS} onChange=${(v) => edit.onEdit(['topEvents', i, 'area'], v)} />
                </div>`}
              </div>`,
            )}
            ${edit && ed.topEvents.length < 3 && html`<button type="button" class="add-row-btn" style="flex:0 0 100%;" onClick=${() => edit.addItem('topEvents')}>+ Add event</button>`}
          </div>

          <div class="projects-panel">
            ${expanded === null || edit
              ? html`<${Fragment}>
                  <div class="panel-header">
                    <div class="panel-header-title">Active Initiatives &amp; Projects</div>
                    <div class="panel-header-sub">${edit ? 'Editing — rows are not collapsible here' : 'Click any row for details →'}</div>
                  </div>
                  <div class="projects-table">
                    <table>
                      <thead><tr><th>Initiative</th><th>Current Status &amp; Provider Action</th></tr></thead>
                      <tbody>
                        ${ed.initiatives.map(
                          (it, i) => html`<tr key=${i} onClick=${() => !edit && setExpanded(it.key || String(i))}>
                            <td>
                              <${Field} edit=${edit} path=${['initiatives', i, 'title']} value=${it.title} />
                              <span class="initiative-tag"><${Field} edit=${edit} path=${['initiatives', i, 'tag']} value=${it.tag} /></span>
                              ${edit && html`<span class="row-tools">
                                <${EnumSelect} value=${it.dot} options=${DOTS} onChange=${(v) => edit.onEdit(['initiatives', i, 'dot'], v)} />
                                <button type="button" class="tool-btn" title="Move up" onClick=${(e) => { e.stopPropagation(); edit.moveItem('initiatives', i, -1); }}>↑</button>
                                <button type="button" class="tool-btn" title="Move down" onClick=${(e) => { e.stopPropagation(); edit.moveItem('initiatives', i, 1); }}>↓</button>
                                ${ed.initiatives.length > 1 && html`<button type="button" class="tool-btn danger" title="Delete" onClick=${(e) => { e.stopPropagation(); edit.removeItem('initiatives', i); }}>×</button>`}
                              </span>`}
                            </td>
                            <td>
                              <span class=${'status-dot dot-' + (DOTS.includes(it.dot) ? it.dot : 'blue')}></span>
                              <strong><${Field} edit=${edit} path=${['initiatives', i, 'statusLead']} value=${it.statusLead} /></strong>
                              ${' '}<${Field} edit=${edit} path=${['initiatives', i, 'statusBody']} value=${it.statusBody} multiline=${true} />
                              ${edit && html`<div class="field-row">
                                <span style="font-size:9px;color:var(--text-light);text-transform:uppercase;letter-spacing:0.06em;">Why</span>
                                <${Field} edit=${edit} path=${['initiatives', i, 'why']} value=${it.why} multiline=${true} className="why-edit" />
                              </div>
                              <div class="field-row">
                                <span style="font-size:9px;color:var(--text-light);text-transform:uppercase;letter-spacing:0.06em;">How</span>
                                <${Field} edit=${edit} path=${['initiatives', i, 'how']} value=${it.how} multiline=${true} />
                              </div>
                              <div class="field-row">
                                <span style="font-size:9px;color:var(--text-light);text-transform:uppercase;letter-spacing:0.06em;">What</span>
                                <${Field} edit=${edit} path=${['initiatives', i, 'what']} value=${it.what} multiline=${true} />
                              </div>`}
                            </td>
                          </tr>`,
                        )}
                      </tbody>
                    </table>
                    ${edit && html`<button type="button" class="add-row-btn" onClick=${() => edit.addItem('initiatives')}>+ Add initiative</button>`}
                  </div>
                <//>`
              : (() => {
                  const it = ed.initiatives.find((i, idx) => (i.key || String(idx)) === expanded);
                  if (!it) {
                    setExpanded(null);
                    return null;
                  }
                  return html`<${Fragment}>
                    <div class="panel-header">
                      <button type="button" class="panel-back-btn" onClick=${() => setExpanded(null)}>‹ Active Initiatives</button>
                      <div class="panel-header-sub">${it.tag}</div>
                    </div>
                    <div class="projects-detail">
                      <div class="detail-meta">
                        <div class="detail-title">${it.title}</div>
                        <div class="detail-status">
                          <span class=${'status-dot dot-' + (DOTS.includes(it.dot) ? it.dot : 'blue')}></span>
                          <strong>${it.statusLead}</strong>${' '}${it.statusBody}
                        </div>
                      </div>
                      <div class="detail-cards">
                        <div class="expand-card"><div class="expand-card-title">Why This Matters</div><div class="expand-card-body">${it.why}</div></div>
                        <div class="expand-card"><div class="expand-card-title">How It Affects Your Workflow</div><div class="expand-card-body">${it.how}</div></div>
                        <div class="expand-card"><div class="expand-card-title">What You Need To Do</div><div class="expand-card-body">${it.what}</div></div>
                      </div>
                    </div>
                  <//>`;
                })()}
          </div>
        </div>
      </div>

      <div class="page-footer">
        <div class="footer-links">
          ${ed.footerLinks.map(
            (f, i) => html`<span key=${i} style=${edit ? 'position:relative;display:inline-flex;align-items:center;gap:4px;' : ''}>
              ${edit
                ? html`<${Fragment}>
                    <${EditableText} value=${f.label} onCommit=${(v) => edit.onEdit(['footerLinks', i, 'label'], v)} className="footer-edit" />
                    ${ed.footerLinks.length > 1 && html`<button type="button" class="tool-btn danger" title="Delete" onClick=${() => edit.removeItem('footerLinks', i)}>×</button>`}
                  <//>`
                : html`<a href=${f.href || '#'} target=${f.href && f.href !== '#' ? '_blank' : undefined} rel="noopener">${f.label}</a>`}
            </span>`,
          )}
          ${edit && html`<button type="button" class="add-row-btn" style="display:inline-block;width:auto;margin:0;padding:4px 10px;" onClick=${() => edit.addItem('footerLinks')}>+ Link</button>`}
        </div>
        <div class="footer-meta">
          <span>Medical Director, Primary &amp; Urgent Care · Crystal Run Healthcare · Optum NY/NJ</span>
          ${!edit && html`<button type="button" class="print-btn" onClick=${() => window.print()}>🖨 Print</button>`}
        </div>
      </div>
    </div>
  </div>`;
}

// ════════════════════════════════════════════════════════════════════
// Read mode
// ════════════════════════════════════════════════════════════════════

function ReadApp() {
  const [edition, setEdition] = useState(null);
  const [error, setError] = useState(null);
  const [layout, setLayout] = useState('landscape');
  const [expanded, setExpanded] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuItems, setMenuItems] = useState([]);

  useEffect(() => {
    apiJson('/api/editions/current').then((r) => {
      if (r.ok) setEdition(r.body);
      else setError(r.status === 404 ? 'No briefing has been published yet.' : r.body?.error || 'Failed to load.');
    });
  }, []);

  const toggleMenu = useCallback(() => {
    setMenuOpen((open) => {
      if (!open) apiJson('/api/editions').then((r) => r.ok && setMenuItems(r.body || []));
      return !open;
    });
  }, []);

  const selectEdition = useCallback((id) => {
    setMenuOpen(false);
    apiJson('/api/editions/' + encodeURIComponent(id)).then((r) => {
      if (r.ok) {
        setEdition(r.body);
        setExpanded(null);
      }
    });
  }, []);

  if (error) {
    return html`<div class="briefing-app"><div class="briefing-status briefing-status--error">
      <h2>Provider Briefing</h2><p>${error}</p>
    </div></div>`;
  }
  if (!edition) {
    return html`<div class="briefing-app"><div class="briefing-status">Loading briefing…</div></div>`;
  }
  return html`<${Briefing}
    edition=${edition}
    layout=${layout}
    setLayout=${setLayout}
    expanded=${expanded}
    setExpanded=${setExpanded}
    edit=${null}
    dateMenu=${{ open: menuOpen, toggle: toggleMenu, select: selectEdition, items: menuItems }}
  />`;
}

// ════════════════════════════════════════════════════════════════════
// Admin mode
// ════════════════════════════════════════════════════════════════════

function blankItemFor(listKey) {
  if (listKey === 'leftAdvisories') return { tint: 'teal', icon: '📋', headline: 'New advisory', body: 'Body text.', tag: 'Tag' };
  if (listKey === 'topEvents') return { area: 'top-b1', tint: 'sky', icon: '📅', headline: 'New event', body: 'Body text.', tag: 'Event' };
  if (listKey === 'initiatives')
    return { key: 'k' + Math.floor(Date.now() % 100000), title: 'New initiative', tag: 'Quality', dot: 'blue', statusLead: 'Status.', statusBody: ' Detail.', why: 'Why.', how: 'How.', what: 'What.' };
  if (listKey === 'footerLinks') return { label: 'New link', href: '#' };
  return {};
}

function Login({ onAuthed }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const r = await apiJson('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
    setBusy(false);
    if (r.ok) onAuthed();
    else if (r.status === 503) setErr('Admin password is not configured on this server.');
    else setErr('Wrong password.');
  };

  return html`<div class="briefing-app"><div class="login-wrap">
    <form class="login-card" onSubmit=${submit}>
      <h1>Provider Briefing</h1>
      <p>Editor sign-in</p>
      <input type="password" placeholder="Password" value=${pw} onInput=${(e) => setPw(e.currentTarget.value)} autofocus />
      <div class="login-error">${err}</div>
      <button type="submit" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </div></div>`;
}

function NewDraftDialog({ editions, onCreate, onClose }) {
  const [from, setFrom] = useState('current');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [title, setTitle] = useState('New edition');

  return html`<div class="modal-backdrop" onClick=${onClose}>
    <div class="modal" onClick=${(e) => e.stopPropagation()}>
      <h2>New draft</h2>
      <label>Copy from</label>
      <select value=${from} onChange=${(e) => setFrom(e.currentTarget.value)}>
        <option value="current">Current published edition</option>
        <option value="blank">Blank starter</option>
        ${editions.map((e) => html`<option value=${e.id}>${e.title} — ${e.date}</option>`)}
      </select>
      <label>Date</label>
      <input type="date" value=${date} onInput=${(e) => setDate(e.currentTarget.value)} />
      <label>Title</label>
      <input type="text" value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} />
      <div class="modal-actions">
        <button type="button" onClick=${onClose}>Cancel</button>
        <button type="button" class="btn-primary" onClick=${() => onCreate({ template_from: from, date, title })}>Create draft</button>
      </div>
    </div>
  </div>`;
}

function Editor({ onLogout }) {
  const [list, setList] = useState([]); // [{id,date,title,published,...}]
  const [currentId, setCurrentId] = useState(null);
  const [selId, setSelId] = useState(null);
  const [edition, setEdition] = useState(null); // working copy (null = none selected)
  const [loaded, setLoaded] = useState(false); // first admin-list fetch resolved
  const [layout, setLayout] = useState('landscape');
  const [saveState, setSaveState] = useState('idle'); // idle|saving|saved|error
  const [showNew, setShowNew] = useState(false);
  const saveTimer = useRef(null);

  const refreshList = useCallback(async (pick) => {
    const r = await apiJson('/api/admin/editions');
    if (!r.ok) {
      // Session likely expired — drop back to the login gate rather than hang.
      if (r.status === 401) onLogout();
      setLoaded(true);
      return null;
    }
    setList(r.body.editions);
    setCurrentId(r.body.current_edition_id);
    const target = pick || selId || r.body.current_edition_id || (r.body.editions[0] && r.body.editions[0].id);
    if (target) {
      const e = r.body.editions.find((x) => x.id === target) || r.body.editions[0];
      setSelId(e.id);
      setEdition(e);
    }
    setLoaded(true); // resolved — even with zero editions, stop showing "Loading…"
    return r.body;
  }, [selId, onLogout]);

  useEffect(() => {
    refreshList();
    // eslint-disable-next-line
  }, []);

  const flushSave = useCallback(async (ed) => {
    setSaveState('saving');
    const payload = {
      date: ed.date,
      title: ed.title,
      issue: ed.issue,
      leftAdvisories: ed.leftAdvisories,
      topEvents: ed.topEvents,
      initiatives: ed.initiatives,
      footerLinks: ed.footerLinks,
    };
    const r = await apiJson('/api/admin/editions/' + encodeURIComponent(ed.id), {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      setSaveState('saved');
      setList((prev) => prev.map((x) => (x.id === ed.id ? { ...x, title: ed.title, date: ed.date } : x)));
    } else {
      setSaveState('error');
    }
  }, []);

  const scheduleSave = useCallback((ed) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushSave(ed), 500);
  }, [flushSave]);

  const applyEdit = useCallback((path, value) => {
    setEdition((prev) => {
      const next = setIn(prev, path, value);
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const addItem = useCallback((listKey) => {
    setEdition((prev) => {
      const next = { ...prev, [listKey]: [...prev[listKey], blankItemFor(listKey)] };
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const removeItem = useCallback((listKey, idx) => {
    setEdition((prev) => {
      const next = { ...prev, [listKey]: prev[listKey].filter((_, i) => i !== idx) };
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const moveItem = useCallback((listKey, idx, dir) => {
    setEdition((prev) => {
      const arr = prev[listKey].slice();
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      const next = { ...prev, [listKey]: arr };
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const selectEdition = useCallback((id) => {
    const e = list.find((x) => x.id === id);
    if (e) {
      setSelId(id);
      setEdition(e);
      setSaveState('idle');
    }
  }, [list]);

  const doCreate = useCallback(async ({ template_from, date, title }) => {
    const r = await apiJson('/api/admin/editions', { method: 'POST', body: JSON.stringify({ template_from, date, title }) });
    setShowNew(false);
    if (r.ok) await refreshList(r.body.id);
  }, [refreshList]);

  const togglePublish = useCallback(async () => {
    if (!edition) return;
    const next = !edition.published;
    if (next && !window.confirm('Make this edition visible to all providers? It will replace the current landing edition.')) return;
    const r = await apiJson('/api/admin/editions/' + encodeURIComponent(edition.id) + '/publish', {
      method: 'POST',
      body: JSON.stringify({ published: next }),
    });
    if (r.ok) {
      setEdition((prev) => ({ ...prev, published: r.body.edition.published, published_at: r.body.edition.published_at }));
      await refreshList(edition.id);
    }
  }, [edition, refreshList]);

  const doLogout = useCallback(async () => {
    await apiJson('/api/admin/logout', { method: 'POST' });
    onLogout();
  }, [onLogout]);

  if (!loaded) {
    return html`<div class="briefing-app"><div class="briefing-status">Loading editor…</div></div>`;
  }

  const saveLabel = { idle: '', saving: 'Saving…', saved: 'Saved', error: 'Save failed — retry edit' }[saveState];

  return html`<${Fragment}>
    <div class="briefing-app admin-mode" style="min-height:0;">
      <div class="admin-bar">
        <span class="admin-bar__brand">Briefing Editor</span>
        ${list.length > 0 &&
        html`<select value=${selId} onChange=${(e) => selectEdition(e.currentTarget.value)}>
          ${list.map((e) => html`<option value=${e.id}>${e.published ? '● ' : '○ '}${e.title} — ${e.date}</option>`)}
        </select>`}
        <button type="button" class="btn-primary" onClick=${() => setShowNew(true)}>+ New draft</button>
        ${edition &&
        html`<${Fragment}>
          <span class=${'chip ' + (edition.published ? 'chip-published' : 'chip-draft')}>${edition.published ? 'Published' : 'Draft'}</span>
          ${edition.id === currentId && html`<span class="chip chip-published">Current</span>`}
        <//>`}
        <span class="admin-bar__spacer"></span>
        ${edition && html`<span class=${'save-state' + (saveState === 'error' ? ' error' : '')}>${saveLabel}</span>`}
        ${edition &&
        html`<label class="publish-toggle">
          <input type="checkbox" checked=${edition.published} onChange=${togglePublish} />
          Published
        </label>`}
        <button type="button" onClick=${doLogout}>Log out</button>
      </div>
    </div>
    ${edition
      ? html`<${Briefing}
          edition=${edition}
          layout=${layout}
          setLayout=${setLayout}
          expanded=${null}
          setExpanded=${() => {}}
          edit=${{ onEdit: applyEdit, addItem, removeItem, moveItem }}
          dateMenu=${null}
        />`
      : html`<div class="briefing-app"><div class="briefing-status">
          <h2 style="font-family:'DM Serif Display',serif;color:var(--crh-navy);">No editions yet</h2>
          <p>Click <strong>+ New draft</strong> above to create your first briefing, then publish it.</p>
        </div></div>`}
    ${showNew && html`<${NewDraftDialog} editions=${list} onCreate=${doCreate} onClose=${() => setShowNew(false)} />`}
  <//>`;
}

function AdminApp() {
  const [authed, setAuthed] = useState(null); // null=checking, false=login, true=editor

  useEffect(() => {
    apiJson('/api/admin/editions').then((r) => setAuthed(r.ok));
  }, []);

  if (authed === null) return html`<div class="briefing-app"><div class="briefing-status">…</div></div>`;
  if (!authed) return html`<${Login} onAuthed=${() => setAuthed(true)} />`;
  return html`<${Editor} onLogout=${() => setAuthed(false)} />`;
}

// ---- mount ----
const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin';
render(html`<${isAdmin ? AdminApp : ReadApp} />`, document.getElementById('app'));
