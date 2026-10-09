// `npm run setup`: asks for your keys, writes .env (owner-only), checks everything, then starts the app.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ENV_FILE, loadConfig } from './config.js';
import { AccountStore } from './store.js';
import { MailService } from './service.js';
import { formatChecks, runChecks } from './doctor.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Sets KEY=value lines in .env text, keeping everything else (comments, other keys) as it is. */
export function upsertEnv(text, updates) {
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Bad variable name: ${k}`);
    if (/[\r\n]/.test(v)) throw new Error(`${k} must be a single line`);
  }
  const render = (k, v) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`;
  const seen = new Set();
  const lines = (text ?? '').split('\n').map((line) => {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m && m[1] in updates) {
      seen.add(m[1]);
      return render(m[1], updates[m[1]]);
    }
    return line;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(render(k, v));
  return `${lines.join('\n')}\n`;
}

function createPrompter() {
  const out = Object.assign(new Writable({ write(chunk, enc, cb) { if (!out.muted) process.stdout.write(chunk, enc); cb(); } }), { muted: false });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: Boolean(process.stdin.isTTY) });
  return {
    async ask(question, { secret = false } = {}) {
      process.stdout.write(question);
      out.muted = secret;
      const answer = (await rl.question('')).trim();
      out.muted = false;
      if (secret) process.stdout.write('\n');
      return answer;
    },
    close: () => rl.close(),
  };
}

const mask = (v) => (v ? `${v.slice(0, 6)}...${v.slice(-4)}` : '');

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

export async function main() {
  const envFile = ENV_FILE;
  const current = loadConfig(process.env);
  const p = createPrompter();
  console.log('\nAll Gmail setup. Press Enter to keep a value that is already set.\n');

  if (!current.google.clientId || !current.google.clientSecret) {
    console.log('You need a Google OAuth client first (free, about 5 minutes):');
    console.log('  1. Enable the Gmail API:   https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    console.log('  2. OAuth consent screen:   https://console.cloud.google.com/apis/credentials/consent');
    console.log('       External, add scope gmail.modify, then PUBLISH the app (status "In production").');
    console.log('       If you leave it in "Testing", Google logs you out every 7 days.');
    console.log('  3. Create credentials:     https://console.cloud.google.com/apis/credentials');
    console.log('       OAuth client ID > Application type "Desktop app". Copy the ID and secret.');
    console.log('  (If a link looks different, search the console for "OAuth consent screen" / "Credentials".)\n');
  }

  const updates = {};
  const id = await p.ask(`Google client ID${current.google.clientId ? ` [${mask(current.google.clientId)}]` : ''}: `);
  if (id) updates.GOOGLE_CLIENT_ID = id.replace(/^["']|["']$/g, '');
  const secret = await p.ask(`Google client secret${current.google.clientSecret ? ' [kept, press Enter]' : ''} (hidden): `, { secret: true });
  if (secret) updates.GOOGLE_CLIENT_SECRET = secret.replace(/^["']|["']$/g, '');
  const key = await p.ask(`Anthropic API key${process.env.ANTHROPIC_API_KEY ? ` [${mask(process.env.ANTHROPIC_API_KEY)}]` : ' (Enter to skip, mail works without it)'} (hidden): `, { secret: true });
  if (key) updates.ANTHROPIC_API_KEY = key.replace(/^["']|["']$/g, '');

  if (Object.keys(updates).length) {
    const base = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    fs.writeFileSync(envFile, upsertEnv(base, updates), { mode: 0o600 });
    fs.chmodSync(envFile, 0o600);
    Object.assign(process.env, updates);
    console.log(`\nSaved ${Object.keys(updates).join(', ')} to .env (readable only by you).`);
  }

  console.log('\nChecking everything...\n');
  const config = loadConfig(process.env);
  const service = new MailService({ config, store: new AccountStore(config.dataDir) });
  const results = await runChecks({ config, service, anthropic: new Anthropic(), checkPort: false });
  console.log(formatChecks(results));

  if (results.some((r) => r.status === 'fail')) {
    console.log('\nFix the items marked with a cross, then run npm run setup again.');
    p.close();
    return 1;
  }
  const go = (await p.ask('\nStart All Gmail now? [Y/n] ')).toLowerCase();
  p.close();
  if (go === 'n' || go === 'no') {
    console.log('Start it any time with: npm start');
    return 0;
  }
  const { start } = await import('./server.js');
  await start(process.env);
  const url = `http://${config.host}:${config.port}`;
  console.log(`\nOpening ${url}. Click "+ Add" for each Gmail account. Ctrl+C stops the app.\n`);
  openBrowser(url);
  return null; // keep running
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { if (code !== null) process.exit(code); }).catch((err) => { console.error(err.message); process.exit(1); });
}
