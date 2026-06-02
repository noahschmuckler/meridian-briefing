// ------------------------------------------------------------------
// meridian-briefing — id generation.
//   newEditionId() → "ed_<YYYYMMDD>_<rand4>"  (human-skimmable + collision-safe)
//   newSessionId() → 32 bytes of hex          (opaque session cookie value)
// ------------------------------------------------------------------

import { randomBytes } from 'node:crypto';

function yyyymmdd(date) {
  const d = date instanceof Date ? date : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function newEditionId(date) {
  const rand = randomBytes(2).toString('hex'); // 4 hex chars
  return `ed_${yyyymmdd(date)}_${rand}`;
}

export function newSessionId() {
  return randomBytes(32).toString('hex');
}
