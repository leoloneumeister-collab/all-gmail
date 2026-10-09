import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { runChecks, formatChecks } from '../src/doctor.js';
import { upsertEnv } from '../src/setup.js';
import { GoogleClientError } from '../src/google-auth.js';
import { loadConfig } from '../src/config.js';
import { MailService } from '../src/service.js';
import { AccountStore } from '../src/store.js';
import { setup } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const claudeOk = { models: { retrieve: async () => ({}) } };
const claudeFails = (err) => ({ models: { retrieve: async () => { throw err; } } });
const by = (results, re) => results.find((r) => re.test(r.title));
const gen = (E, status, msg) => E.generate(status, { error: { type: 'x', message: msg } }, msg, new Headers());

test('doctor: everything fine gives only ok results', async () => {
  const t = await setup();
  const r = await runChecks({ config: t.config, service: t.service, anthropic: claudeOk, checkPort: false });
  assert.deepEqual(r.map((x) => x.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.match(by(r, /Claude works/).title, /claude-opus-5-5/);
  assert.equal(r.filter((x) => /can be read/.test(x.title)).length, 3);
  assert.match(formatChecks(r), /All good\./);
  await t.close();
});

test('doctor: a wrong Google client is reported with the fix, before any browser login', async () => {
  const t = await setup({ connect: [], env: { GOOGLE_CLIENT_ID: 'wrong-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'wrong' } });
  const r = await runChecks({ config: t.config, service: t.service, anthropic: claudeOk, checkPort: false });
  const bad = by(r, /rejected your client/);
  assert.equal(bad.status, 'fail');
  assert.match(bad.detail, /not found/);
  assert.match(bad.fix, /Clients/);
  assert.match(formatChecks(r), /1 problem\(s\) to fix/);
  await t.close();
});

test('doctor: missing Google settings point to npm run setup', async () => {
  const t = await setup({ connect: [], env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
  const r = await runChecks({ config: t.config, service: t.service, anthropic: claudeOk, checkPort: false });
  assert.equal(by(r, /not configured/).status, 'fail');
  assert.match(by(r, /not configured/).fix, /npm run setup/);
  await t.close();
});

test('doctor: a dead account says to reconnect and the others stay ok', async () => {
  const t = await setup();
  t.fake.state.forceInvalidGrant.add('leo.personal@example.com');
  t.service.auth.tokens.clear();
  const r = await runChecks({ config: t.config, service: t.service, anthropic: claudeOk, checkPort: false });
  assert.equal(by(r, /leo\.personal/).status, 'fail');
  assert.match(by(r, /leo\.personal/).fix, /reconnect/);
  assert.equal(by(r, /leo\.work/).status, 'ok');
  assert.equal(by(r, /studio/).status, 'ok');
  await t.close();
});

test('doctor: Claude problems are told apart', async () => {
  const t = await setup();
  const run = async (anthropic) => by(await runChecks({ config: t.config, service: t.service, anthropic, checkPort: false }), /Claude|Anthropic|Model|ANTHROPIC/);
  assert.equal((await run(claudeFails(gen(Anthropic.AuthenticationError, 401, 'invalid x-api-key')))).status, 'fail');
  const nf = await run(claudeFails(gen(Anthropic.NotFoundError, 404, 'model: nope')));
  assert.equal(nf.status, 'fail');
  assert.match(nf.title, /claude-opus-5-5/);
  const noKey = await run(claudeFails(new Error('Could not resolve authentication method. Expected one of apiKey ...')));
  assert.equal(noKey.status, 'warn');
  assert.match(noKey.title, /No ANTHROPIC_API_KEY/);
  assert.equal((await run(claudeFails(new Anthropic.APIConnectionError({ message: 'offline' })))).status, 'warn');
  await t.close();
});

test('doctor: no accounts yet is a note, not an error', async () => {
  const t = await setup({ connect: [] });
  const r = await runChecks({ config: t.config, service: t.service, anthropic: claudeOk, checkPort: false });
  assert.equal(by(r, /No Gmail accounts/).status, 'warn');
  assert.ok(!r.some((x) => x.status === 'fail'));
  await t.close();
});

test('a wrong client during login gives a message that names the .env settings', async () => {
  const t = await setup({ connect: [], env: { GOOGLE_CLIENT_ID: 'wrong', GOOGLE_CLIENT_SECRET: 'wrong' } });
  const { state } = t.service.auth.createAuthRequest();
  await assert.rejects(() => t.service.connect({ code: 'x', state }), (e) => e instanceof GoogleClientError && /GOOGLE_CLIENT_ID/.test(e.message));
  const { state: s2 } = t.service.auth.createAuthRequest();
  const cb = await t.call(`/auth/callback?code=x&state=${s2}`);
  assert.equal(cb.status, 302);
  assert.match(decodeURIComponent(cb.headers.get('location')), /GOOGLE_CLIENT_ID/);
  await t.close();
});

test('upsertEnv replaces and appends, keeps comments and other keys, quotes awkward values', () => {
  const before = '# my notes\nGOOGLE_CLIENT_ID=old\nPORT=9000\n\n# tail\n';
  const after = upsertEnv(before, { GOOGLE_CLIENT_ID: 'new-id', ANTHROPIC_API_KEY: 'sk-ant-x', NOTE: 'has space # and hash' });
  assert.equal(after, '# my notes\nGOOGLE_CLIENT_ID=new-id\nPORT=9000\n\n# tail\nANTHROPIC_API_KEY=sk-ant-x\nNOTE="has space # and hash"\n');
  assert.equal(upsertEnv('', { A_B: '1' }), 'A_B=1\n');
  assert.throws(() => upsertEnv('', { KEY: 'a\nb' }), /single line/);
  assert.throws(() => upsertEnv('', { 'bad key': 'x' }), /Bad variable/);
});

test('npm run setup, answered like a person would: writes a private .env, checks, and can stop before starting', async () => {
  const t = await setup({ connect: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-setup-'));
  const envFile = path.join(dir, '.env');
  const child = spawn(process.execPath, [path.join(root, 'src/setup.js')], {
    env: {
      PATH: process.env.PATH, HOME: dir, ALL_GMAIL_ENV_FILE: envFile, ALL_GMAIL_DATA_DIR: path.join(dir, 'data'),
      GOOGLE_AUTH_URL: t.fake.env.GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL: t.fake.env.GOOGLE_TOKEN_URL, GMAIL_API_BASE: t.fake.env.GMAIL_API_BASE,
      ANTHROPIC_API_KEY: '', PORT: '8787',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  const answers = [[/Google client ID/, 'fake-client\n'], [/Google client secret/, 'fake-secret\n'], [/Anthropic API key/, '\n'], [/Start All Gmail now/, 'n\n']];
  child.stdout.on('data', (d) => {
    out += d;
    while (answers.length && answers[0][0].test(out)) {
      const [, reply] = answers.shift();
      out += '\u0000'; // make sure the same prompt is not matched twice
      child.stdin.write(reply);
    }
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, out);
  assert.match(out, /Saved GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET to \.env/);
  assert.match(out, /Google accepts your client ID and secret/);
  assert.match(out, /No ANTHROPIC_API_KEY/);
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /^GOOGLE_CLIENT_ID=fake-client$/m);
  assert.match(env, /^GOOGLE_CLIENT_SECRET=fake-secret$/m);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.ok(!out.includes('fake-secret'), 'the secret must not be echoed');
  fs.rmSync(dir, { recursive: true, force: true });
  await t.close();
});
