// `npm run demo`: runs the whole app against a fake Google with three sample mailboxes.
// No Google setup needed. If ANTHROPIC_API_KEY is set, the Claude features work on the sample mail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeGoogle, signIn, FAKE_ACCOUNTS } from './fake-google.js';
import { start } from '../src/server.js';

const fake = await createFakeGoogle({ port: Number(process.env.FAKE_GOOGLE_PORT || 8799) });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'all-gmail-demo-'));
const { service, config } = await start({ ...process.env, ...fake.env, ALL_GMAIL_DATA_DIR: dataDir });

// Sign the three sample accounts in, the same way a browser would.
for (const { email } of FAKE_ACCOUNTS) await signIn(service, email);
const labels = { 'leo.work@acme-example.com': 'Work', 'leo.personal@example.com': 'Personal', 'studio@leolabs-example.com': 'Studio' };
for (const a of await service.accounts()) await service.updateAccount(a.id, { label: labels[a.email] });
console.log('\nDemo mode: sample mail only, nothing touches real Gmail.');
console.log(`Open http://${config.host}:${config.port}\n`);
process.on('SIGINT', () => { fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); });
