// ------------------------------------------------------------------
// meridian-briefing — admin password hasher.
//
//   npm run hash-password
//
// Prompts for a password (echo suppressed), derives a scrypt hash + random
// salt, and prints the two lines to paste into .env:
//
//   ADMIN_PASSWORD_HASH=<hex>
//   ADMIN_PASSWORD_SALT=<hex>
//
// The plaintext password never touches disk and never leaves this process.
// Run it on the Linux dev box; paste the output into .env on each machine
// (dev / orange device / CR DEV server). To rotate, re-run and replace both.
//
// Non-interactive use (CI / scripted dev): pipe the password on stdin, e.g.
//   echo 'mypw' | node scripts/hash-password.mjs
// ------------------------------------------------------------------

import { createInterface } from 'node:readline';
import { hashPassword } from '../lib/auth.js';

function promptHidden(question) {
  return new Promise((resolve) => {
    const terminal = Boolean(process.stdin.isTTY);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal });

    let muted = false;
    // While muted, swallow readline's character echo so the password isn't shown.
    rl._writeToOutput = (str) => {
      if (!muted) rl.output.write(str);
    };

    rl.question(question, (answer) => {
      rl.close();
      if (terminal) process.stdout.write('\n');
      resolve(answer);
    });
    muted = true; // mute echo for everything typed after the prompt text
  });
}

const pw = (await promptHidden('Admin password: ')).trim();
if (!pw) {
  console.error('No password entered. Aborting.');
  process.exit(1);
}
if (pw.length < 8) {
  console.error(`Warning: password is only ${pw.length} chars. 8+ recommended.`);
}

const { hashHex, saltHex } = hashPassword(pw);

console.log('\nPaste these two lines into .env (replace any existing pair):\n');
console.log(`ADMIN_PASSWORD_HASH=${hashHex}`);
console.log(`ADMIN_PASSWORD_SALT=${saltHex}`);
console.log('');
