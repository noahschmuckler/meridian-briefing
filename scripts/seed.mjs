// ------------------------------------------------------------------
// meridian-briefing — dev seed. Writes one PUBLISHED edition into the local
// state.json so the read view renders immediately without first using /admin.
// Content mirrors the meridian-os Briefing app (BriefingApp.tsx) as of the port.
//
//   npm run seed            # writes ./data/state.json (or $BRIEFING_DB)
//
// Safe to re-run — it overwrites the whole document. Do NOT run on the server
// (it would clobber real editions); it's a local-iteration convenience.
// ------------------------------------------------------------------

import { writeState, normalizeEdition, recomputeCurrentId, dbPath } from '../lib/store.js';
import { newEditionId } from '../lib/id.js';

const edition = normalizeEdition({
  id: newEditionId(new Date('2025-06-16')),
  date: '2025-06-16',
  title: 'Provider Briefing — Week of June 16, 2025',
  published: true,
  published_at: new Date('2025-06-16T12:00:00Z').toISOString(),
  issue: {
    masthead_label: 'Week of June 16, 2025',
    issue_label: 'Vol. 1 · Issue 3 · Distribution: All Providers',
  },
  leftAdvisories: [
    {
      tint: 'teal',
      icon: '📋',
      headline: 'PREVENT Calculator',
      body: 'Use the AHA PREVENT tool for all patients with hyperlipidemia or elevated CVD risk. Available in Meridian → Cardiovascular.',
      tag: 'Clinical Reminder',
    },
    {
      tint: 'coral',
      icon: '🩺',
      headline: 'BP Recheck Protocol',
      body: 'Elevated BP on first read? Always obtain a second measurement before closing the visit. Document both values in Epic.',
      tag: 'Quality',
    },
    {
      tint: 'sage',
      icon: '🔬',
      headline: 'Urine Microalbumin:Cr',
      body: 'Order UACR annually for all patients with diabetes and for patients with suspected CKD. Closes a HEDIS gap.',
      tag: 'HEDIS · Kidney',
    },
    {
      tint: 'lavender',
      icon: '💊',
      headline: 'Controlled Substances',
      body: 'Check PDMP at every opioid or benzo prescription. New prescribing framework available in Meridian → Controlled Substances.',
      tag: 'Compliance',
    },
  ],
  topEvents: [
    {
      area: 'top-b1',
      tint: 'sky',
      icon: '📅',
      headline: 'Provider Dinner — June 16',
      body: 'Crystal Run Healthcare Annual Provider Dinner. All primary & urgent care providers welcome. RSVP to Amanda Grady by June 9.',
      tag: 'Event',
    },
    {
      area: 'top-b2',
      tint: 'gold',
      icon: '💻',
      headline: 'Epic THRIVE Sessions',
      body: 'Upcoming Epic efficiency workshops — June 18 & 25 at Middletown. CME credit available. Register via the Learning Portal.',
      tag: 'Training · CME',
    },
    {
      area: 'top-b3',
      tint: 'warm',
      icon: '🌐',
      headline: 'Age-Wise Program Update',
      body: 'New Age-Wise documentation workflows are live in Epic. NP wellness visit completion now tracked on the Quality Dashboard.',
      tag: 'Announcement',
    },
  ],
  initiatives: [
    {
      key: 'lipid',
      title: 'Lipid Management QI',
      tag: 'HEDIS · Cardiology',
      dot: 'green',
      statusLead: 'Active.',
      statusBody:
        ' 90-day project underway with Dr. Hines. LDL goal attainment tracked monthly. Providers with outlier panels will receive a Meridian flag. Statin initiation for ASCVD patients is the primary focus through Q3.',
      why: 'LDL reduction is one of the highest-yield interventions for preventing MI and stroke. Our panel shows ~30% of high-risk patients are not at goal.',
      how: "Meridian will surface a lipid flag on patients with ASCVD or 10-year risk >10% whose LDL hasn't been checked in 12 months or is above target.",
      what: 'For flagged patients: order a fasting lipid panel if due, titrate statin therapy per guidelines, or document a reason for deviation.',
    },
    {
      key: 'awv',
      title: 'NP Annual Wellness Visits',
      tag: 'Preventive · Revenue',
      dot: 'blue',
      statusLead: 'Ramping.',
      statusBody:
        " NP-led AWV program expanding to Monroe and West Nyack sites in June. Scheduling templates updated. Providers: please refer eligible Medicare patients who haven't had an AWV in 12 months.",
      why: 'Annual Wellness Visits are fully covered by Medicare and capture preventive care gaps that drive quality scores and downstream revenue.',
      how: 'A new SmartList in Epic identifies patients overdue for AWV. NPs handle the visit; you sign a brief attestation if a medical decision is needed.',
      what: 'At any visit for an eligible Medicare patient, place a referral to the AWV schedule. Takes under 30 seconds via the Epic order set.',
    },
    {
      key: 'hedis',
      title: 'HEDIS Gap Closure',
      tag: 'Quality · Stars',
      dot: 'green',
      statusLead: 'Q2 Sprint.',
      statusBody:
        " Priority measures: Colorectal Cancer Screening, Diabetes Eye Exam, Controlling High Blood Pressure (CBP), and UACR. Gap lists updated weekly. Use the Meridian HEDIS module to view your panel's open gaps.",
      why: "HEDIS performance directly affects CRH's payer contract rates and Star ratings. Closing gaps now avoids chart-chase season in Q4.",
      how: 'Meridian surfaces open HEDIS gaps at the point of care. Staff will also pre-screen charts and queue orders before eligible visits.',
      what: 'Review the HEDIS flag when it appears in the patient banner. Order the indicated screening or document a valid exclusion code.',
    },
    {
      key: 'qic',
      title: 'Quality Improvement Committee',
      tag: 'Governance',
      dot: 'yellow',
      statusLead: 'Next Meeting: June 24.',
      statusBody:
        ' QIC reviewing transfer threshold variation data from Urgent Care sites. Preliminary findings to be presented. Feedback from attending providers welcome prior to meeting via the Meridian survey link.',
      why: 'Variation in transfer decisions drives both patient safety risk and cost. The QIC is working to establish evidence-based thresholds for common presentations.',
      how: 'A brief anonymous calibration survey (Threshold tool) will be distributed ahead of the June 24 meeting. Takes 5–7 minutes.',
      what: 'Complete the Threshold survey when distributed. Attendance at the June 24 meeting is encouraged for UC providers.',
    },
    {
      key: 'wrvu',
      title: 'Work RVU Targets',
      tag: 'Operations · Finance',
      dot: 'blue',
      statusLead: 'Q2 Tracking On Pace.',
      statusBody:
        ' Individual provider dashboards updated through May. Most sites within 5% of target. Middletown UC tracking slightly below; leadership meeting scheduled. Questions: contact Amanda Grady.',
      why: 'RVU performance informs staffing decisions, compensation adjustments, and site-level resource allocation for the coming fiscal year.',
      how: 'Your personal RVU dashboard is accessible in the Operations section of Meridian. Updated monthly with a 2-week lag.',
      what: 'Review your dashboard. If you believe there are coding or charge capture errors, flag them to your site coordinator within 30 days of the service date.',
    },
    {
      key: 'variation',
      title: 'Clinical Variation Reduction',
      tag: 'Quality · Ops',
      dot: 'purple',
      statusLead: 'Planning Phase.',
      statusBody:
        ' Scoping which high-variation conditions to prioritize (UTI, URI, back pain, chest pain disposition). Provider input is being gathered. Phase 1 protocols expected in Meridian by August.',
      why: 'Unwarranted clinical variation increases costs, reduces predictability of care, and can signal practice drift from evidence-based guidelines.',
      how: 'Eventually, Meridian will offer condition-specific guidance at the point of care. In the planning phase, no action is required.',
      what: 'Watch for a brief survey on UTI and URI prescribing patterns, coming in July. Your input directly shapes the protocol design.',
    },
  ],
  footerLinks: [
    { label: 'Meridian Home', href: '/home' },
    { label: 'HEDIS Dashboard', href: '#' },
    { label: 'Epic Learning Portal', href: '#' },
    { label: 'Quality Dashboard', href: '#' },
    { label: 'Submit Feedback', href: '#' },
  ],
});

const state = {
  schema_version: 1,
  current_edition_id: edition.id,
  editions: [edition],
};
state.current_edition_id = recomputeCurrentId(state);

await writeState(state);
console.log(`Seeded 1 published edition → ${dbPath()}`);
console.log(`  current_edition_id = ${state.current_edition_id}`);
