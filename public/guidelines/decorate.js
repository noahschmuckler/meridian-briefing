// ------------------------------------------------------------------
// Clinical Guidelines — HTML-string decoration helpers.
//
// Plain-JS port of meridian-os src/lib/refMarkers.ts + src/lib/glossary.ts
// (the consult-mention decorator is PR2). These run in the browser render
// path and operate on the schema-1.1.0+ clinical-module shape:
//   - `[ref:X]` inline markers + a top-level `references[]` array
//   - a global glossary (term / expansion / aliases / definition)
//
// Kept faithful to the meridian-os behaviour: per-module first-appearance
// numbering shared between the marker-expansion pass and the citation list;
// DOM-walk glossary decoration that skips <a>/<code>/<sup> and already-
// decorated spans; case-sensitive, every-occurrence, longest-match-first.
// ------------------------------------------------------------------

const MARKER_RE = /\[ref:([a-z0-9-]+)\]/gi;

export function stripRefMarkers(text) {
  return (text || '').replace(MARKER_RE, '');
}

// Collapse string | {ref_id, citation, url} entries to a uniform shape so
// legacy modules (plain-string references) still resolve.
export function normalizeReferences(refs) {
  if (!refs) return [];
  return refs.map((r, i) =>
    typeof r === 'string' ? { ref_id: `ref-${i + 1}`, citation: r } : r,
  );
}

// Stateful numberer: assigns 1..N as ref_ids are first encountered; returns
// null for ref_ids not declared in the module.
function makeRefNumberer(refs) {
  const byId = new Map(refs.map((r) => [r.ref_id, r]));
  const order = [];
  const seen = new Map();
  return {
    numberFor(refId) {
      const ref = byId.get(refId);
      if (!ref) return null;
      const cached = seen.get(refId);
      if (cached) return cached;
      const n = order.length + 1;
      seen.set(refId, n);
      order.push({ number: n, ref });
      return n;
    },
    cited() {
      return order;
    },
  };
}

// Pre-walk every cite-bearing field in print order so a superscript [37] in
// the FAQ resolves to the same ref it would on the (notional) print page:
// landing_intro -> green_zone narrative -> context_strip -> faqs -> footer_note.
export function getModuleRefNumberer(module) {
  const refs = normalizeReferences(module.references);
  const numberer = makeRefNumberer(refs);

  function walk(text) {
    if (!text) return;
    let m;
    MARKER_RE.lastIndex = 0;
    while ((m = MARKER_RE.exec(text)) !== null) numberer.numberFor(m[1]);
  }

  walk(module.landing_intro);
  walk(module.green_zone && module.green_zone.narrative_html);
  walk(module.context_strip && module.context_strip.text);
  for (const faq of module.faqs || []) {
    walk(faq.first_layer_html);
    for (const qa of faq.sub_questions || []) walk(qa.answer_html);
    for (const qa of faq.items || []) walk(qa.answer_html);
  }
  walk(module.footer_note);
  return numberer;
}

// Replace every `[ref:X]` with a superscript anchor; undeclared refs fall
// back to a visible grey token rather than vanishing silently.
export function expandRefMarkers(html, module, numberer) {
  const n = numberer || getModuleRefNumberer(module);
  return (html || '').replace(MARKER_RE, (_match, refId) => {
    const num = n.numberFor(refId);
    if (num === null) {
      return `<span class="ref-marker ref-marker--missing" title="Reference ${refId} not declared">[ref:${refId}]</span>`;
    }
    return `<sup class="ref-marker"><a href="#ref-${refId}" data-ref="${refId}">[${num}]</a></sup>`;
  });
}

// The cited refs that appear in just the supplied HTML fragment(s), numbered
// against the module's full numbering — what the focused FAQ should list.
export function getReferencesUsedIn(htmlFragments, module, numberer) {
  const n = numberer || getModuleRefNumberer(module);
  const refs = normalizeReferences(module.references);
  const seen = new Set();
  const out = [];
  for (const html of htmlFragments) {
    let m;
    MARKER_RE.lastIndex = 0;
    while ((m = MARKER_RE.exec(html || '')) !== null) {
      const refId = m[1];
      if (seen.has(refId)) continue;
      const num = n.numberFor(refId);
      if (num === null) continue;
      const ref = refs.find((r) => r.ref_id === refId);
      if (!ref) continue;
      seen.add(refId);
      out.push({ number: num, ref });
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

// ---- glossary decoration --------------------------------------------------

const SKIP_TAGS = new Set([
  'A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'SUP', 'SUB',
  'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'KBD',
]);
const SKIP_CLASSES = new Set(['glossary-term', 'ref-marker']);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Single combined regex over all term + alias strings. Longest-first so
// longer aliases win; \b keeps us off mid-word matches; case-sensitive by
// design (PDMP must not match pdmp inside a URL).
function compileMatcher(entries) {
  if (!entries || entries.length === 0) return null;
  const byMatch = new Map();
  const tokens = [];
  for (const e of entries) {
    const variants = [e.term, ...(e.aliases || [])];
    for (const v of variants) {
      if (!v) continue;
      if (!byMatch.has(v)) {
        byMatch.set(v, e);
        tokens.push(v);
      }
    }
  }
  if (tokens.length === 0) return null;
  tokens.sort((a, b) => b.length - a.length);
  const escaped = tokens.map(escapeRegex);
  const re = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'g');
  return { re, byMatch };
}

// Module glossary entries override the global by exact term match; module
// first, then the remaining globals.
export function getMergedGlossary(module, global) {
  const moduleEntries = (module && module.glossary) || [];
  if (moduleEntries.length === 0) return global;
  const moduleTerms = new Set(moduleEntries.map((e) => e.term));
  return [...moduleEntries, ...global.filter((e) => !moduleTerms.has(e.term))];
}

function decorateRoot(root, matcher) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        for (const cls of SKIP_CLASSES) {
          if (p.classList.contains(cls)) return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets = [];
  let n = walker.nextNode();
  while (n) {
    targets.push(n);
    n = walker.nextNode();
  }

  const { re, byMatch } = matcher;
  for (const node of targets) {
    const text = node.nodeValue || '';
    if (!text) continue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;

    re.lastIndex = 0;
    let last = 0;
    const frag = document.createDocumentFragment();
    let touched = false;
    let m = re.exec(text);
    while (m !== null) {
      const matchedStr = m[0];
      const entry = byMatch.get(matchedStr);
      if (!entry) {
        m = re.exec(text);
        continue;
      }
      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const span = document.createElement('span');
      span.className = 'glossary-term';
      span.dataset.term = entry.term;
      span.textContent = matchedStr;
      frag.appendChild(span);
      last = m.index + matchedStr.length;
      touched = true;
      m = re.exec(text);
    }
    if (!touched) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  }
}

export function decorateGlossaryHtml(html, entries) {
  const matcher = compileMatcher(entries);
  if (!matcher) return html;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  decorateRoot(wrapper, matcher);
  return wrapper.innerHTML;
}

export function decorateGlossaryText(text, entries) {
  const matcher = compileMatcher(entries);
  if (!matcher) {
    const escape = document.createElement('div');
    escape.textContent = text;
    return escape.innerHTML;
  }
  const wrapper = document.createElement('div');
  wrapper.textContent = text;
  decorateRoot(wrapper, matcher);
  return wrapper.innerHTML;
}

export function findGlossaryEntry(term, entries) {
  for (const e of entries) {
    if (e.term === term) return e;
    if (e.aliases && e.aliases.includes(term)) return e;
  }
  return null;
}
