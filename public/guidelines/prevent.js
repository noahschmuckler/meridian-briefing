// ------------------------------------------------------------------
// PREVENT calculator — AHA/ACC 10-year ASCVD risk. Ported from
// meridian-os src/bubbles/prevent-calculator. Local useState replaces the
// shared preventInputsSignal (no cross-surface round-trip here).
//
// Coefficients are PREVENT-shape, modeled after Khan SS et al, Circulation
// 2023;148(24):1982-2004 (Table S5), with the linear-predictor constant
// hand-calibrated. DRAFT / demonstration code — verify against acc.org/PREVENT
// before clinical use.
// ------------------------------------------------------------------

import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

const DEFAULTS = {
  age: 55,
  sex: 'female',
  totalChol: 200,
  hdl: 50,
  sbp: 130,
  bpMed: false,
  diabetes: false,
  smoker: false,
  egfr: 90,
  statin: false,
};

const TC_FACTOR = 0.02586; // mg/dL -> mmol/L

const FEMALE = {
  constant: -3.6, age: 0.7939329, nonHdl: 0.0305239, hdl: -0.1606857,
  sbpLow: -0.2394003, sbpHigh: 0.3600781, diabetes: 0.8667604, smoker: 0.5360739,
  egfrLow: 0.6045917, bpMed: 0.3151672, statin: -0.1477655, ageNonHdl: -0.0663612,
  ageHdl: 0.1015067, ageSbpHigh: -0.0855880, ageDiabetes: -0.2899091, ageSmoker: -0.1542850,
};

const MALE = {
  constant: -3.3, age: 0.7688528, nonHdl: 0.0736174, hdl: -0.0954431,
  sbpLow: -0.4347345, sbpHigh: 0.3362658, diabetes: 0.7692857, smoker: 0.4386871,
  egfrLow: 0.5378979, bpMed: 0.2889610, statin: -0.1337349, ageNonHdl: -0.0475924,
  ageHdl: 0.0844398, ageSbpHigh: -0.0518984, ageDiabetes: -0.2553929, ageSmoker: -0.1521243,
};

function classifyTier(risk) {
  if (risk < 5) return { label: 'Low', color: '#0F6B42', detail: 'No statin indicated.' };
  if (risk < 7.5) return { label: 'Borderline', color: '#B45309', detail: 'Shared decision-making · statin reasonable if LDL ≥70 plus risk enhancers.' };
  if (risk < 20) return { label: 'Intermediate', color: '#B45309', detail: 'Initiate statin.' };
  return { label: 'High', color: '#d92e2e', detail: 'High-intensity statin · no shared decision-making required.' };
}

function compute(inputs) {
  const { age, sex, totalChol, hdl, sbp, bpMed, diabetes, smoker, egfr, statin } = inputs;
  if (
    !Number.isFinite(age) || age < 30 || age > 79
    || !Number.isFinite(totalChol) || totalChol < 100 || totalChol > 400
    || !Number.isFinite(hdl) || hdl < 20 || hdl > 120
    || !Number.isFinite(sbp) || sbp < 80 || sbp > 220
    || !Number.isFinite(egfr) || egfr < 15 || egfr > 140
  ) return null;

  const c = sex === 'female' ? FEMALE : MALE;
  const ageTerm = (age - 55) / 10;
  const nonHdlTerm = (totalChol - hdl) * TC_FACTOR - 3.5;
  const hdlTerm = (hdl * TC_FACTOR - 1.3) / 0.3;
  const sbpLowTerm = Math.min(sbp - 110, 0) / 20;
  const sbpHighTerm = Math.max(sbp - 110, 0) / 20;
  const egfrLowTerm = Math.min(egfr - 60, 0) / -15;
  const dm = diabetes ? 1 : 0;
  const sm = smoker ? 1 : 0;
  const bpm = bpMed ? 1 : 0;
  const stat = statin ? 1 : 0;

  const lp =
    c.constant
    + c.age * ageTerm + c.nonHdl * nonHdlTerm + c.hdl * hdlTerm
    + c.sbpLow * sbpLowTerm + c.sbpHigh * sbpHighTerm
    + c.diabetes * dm + c.smoker * sm + c.egfrLow * egfrLowTerm
    + c.bpMed * bpm + c.statin * stat
    + c.ageNonHdl * ageTerm * nonHdlTerm + c.ageHdl * ageTerm * hdlTerm
    + c.ageSbpHigh * ageTerm * sbpHighTerm + c.ageDiabetes * ageTerm * dm
    + c.ageSmoker * ageTerm * sm;

  const risk = 1 / (1 + Math.exp(-lp));
  return Math.round(risk * 1000) / 10;
}

export function PreventCalculator() {
  const [inputs, setInputs] = useState(DEFAULTS);
  const update = (key, value) => setInputs((prev) => ({ ...prev, [key]: value }));
  const reset = () => setInputs(DEFAULTS);

  const risk = compute(inputs);
  const tier = risk == null ? null : classifyTier(risk);

  return html`<div class="cm-bubble" style=${{ '--type-color': '#f4c020' }}>
    <div class="bubble__chrome">
      <span class="bubble__title" style="color:var(--type-color)">PREVENT · 10-yr ASCVD</span>
      <button type="button" class="cm-prevent__reset" title="Reset to defaults" onClick=${reset}>reset</button>
    </div>
    <div class="bubble__body">
      <div class="cm-prevent__grid">
        <${NumberField} label="Age" min=${30} max=${79} value=${inputs.age} onChange=${(v) => update('age', v)} />
        <${SegmentField} label="Sex" value=${inputs.sex}
          options=${[{ key: 'female', label: 'Female' }, { key: 'male', label: 'Male' }]}
          onChange=${(v) => update('sex', v)} />
        <${NumberField} label="Total chol (mg/dL)" min=${100} max=${400} value=${inputs.totalChol} onChange=${(v) => update('totalChol', v)} />
        <${NumberField} label="HDL (mg/dL)" min=${20} max=${120} value=${inputs.hdl} onChange=${(v) => update('hdl', v)} />
        <${NumberField} label="SBP (mmHg)" min=${80} max=${220} value=${inputs.sbp} onChange=${(v) => update('sbp', v)} />
        <${NumberField} label="eGFR" min=${15} max=${140} value=${inputs.egfr} onChange=${(v) => update('egfr', v)} />
      </div>

      <div class="cm-prevent__toggles">
        <${ToggleRow} label="On BP medication" value=${inputs.bpMed} onChange=${(v) => update('bpMed', v)} />
        <${ToggleRow} label="Diabetes" value=${inputs.diabetes} onChange=${(v) => update('diabetes', v)} />
        <${ToggleRow} label="Current smoker" value=${inputs.smoker} onChange=${(v) => update('smoker', v)} />
        <${ToggleRow} label="On statin" value=${inputs.statin} onChange=${(v) => update('statin', v)} />
      </div>

      <div class="cm-prevent__result" style=${{ borderLeft: tier ? `4px solid ${tier.color}` : '4px solid transparent' }}>
        ${risk == null
          ? html`<div class="cm-prevent__invalid">Inputs out of valid range.</div>`
          : html`<div>
              <div class="cm-prevent__result-row">
                <span class="cm-prevent__pct" style=${{ color: tier.color }}>${risk.toFixed(1)}%</span>
                <span class="cm-prevent__tier" style=${{ color: tier.color }}>${tier.label} risk</span>
              </div>
              <div class="cm-prevent__detail">${tier.detail}</div>
            </div>`}
      </div>

      <div class="cm-prevent__draft">
        <strong>Draft — not validated.</strong>${' '}
        PREVENT-shape model with hand-calibrated constants. Verify every result against${' '}
        <a href="https://professional.heart.org/en/guidelines-and-statements/prevent-calculator" target="_blank" rel="noreferrer">the official PREVENT calculator</a>${' '}
        before any clinical decision.
      </div>
    </div>
  </div>`;
}

function NumberField({ label, min, max, value, onChange }) {
  return html`<label class="cm-field">
    <span class="cm-field__label">${label}</span>
    <input
      type="number"
      inputMode="numeric"
      min=${min}
      max=${max}
      value=${value}
      onInput=${(e) => {
        const raw = e.currentTarget.value;
        const parsed = raw === '' ? NaN : Number(raw);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  </label>`;
}

function SegmentField({ label, value, options, onChange }) {
  return html`<div class="cm-field">
    <span class="cm-field__label">${label}</span>
    <div class="cm-segment">
      ${options.map((opt) => html`<button
        key=${opt.key}
        type="button"
        class=${'cm-segment__btn' + (opt.key === value ? ' cm-segment__btn--active' : '')}
        onClick=${() => onChange(opt.key)}
      >${opt.label}</button>`)}
    </div>
  </div>`;
}

function ToggleRow({ label, value, onChange }) {
  return html`<button type="button" class="cm-toggle" onClick=${() => onChange(!value)}>
    <span class=${'cm-toggle__track' + (value ? ' cm-toggle__track--on' : '')}>
      <span class="cm-toggle__knob"></span>
    </span>
    <span>${label}</span>
  </button>`;
}
