import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStore, PALETTE, publicAccount } from '../src/store.js';
import { AuthError, GoogleAuth } from '../src/google-auth.js';
import { loadConfig } from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-store-'));

test('store keeps refresh tokens in a file only the owner can read', async () => {
  const dir = path.join(tmp(), 'nested');
  const store = new AccountStore(dir);
  await store.upsert({ email: 'A@x.io', refreshToken: 'rt-a' });
  assert.equal(fs.statSync(path.join(dir, 'accounts.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('store assigns distinct colors, keeps ids stable, and upserts instead of duplicating', async () => {
  const store = new AccountStore(tmp());
  const a = await store.upsert({ email: 'a@x.io', refreshToken: '1' });
  const b = await store.upsert({ email: 'b@x.io', refreshToken: '2' });
  const c = await store.upsert({ email: 'c@x.io', refreshToken: '3' });
  assert.equal(new Set([a.color, b.color, c.color]).size, 3);
  assert.ok(PALETTE.includes(a.color));
  const again = await store.upsert({ email: 'A@X.io', refreshToken: 'new' });
  assert.equal(again.id, a.id);
  assert.equal(again.color, a.color);
  const all = await store.list();
  assert.equal(all.length, 3);
  assert.equal(all[0].refreshToken, 'new');
});

test('store.update only touches label, color and persona and trims length', async () => {
  const store = new AccountStore(tmp());
  const a = await store.upsert({ email: 'a@x.io', refreshToken: 'secret' });
  const u = await store.update(a.id, { label: 'Work', persona: 'formal', refreshToken: 'hacked', email: 'evil@x.io' });
  assert.equal(u.label, 'Work');
  assert.equal(u.refreshToken, 'secret');
  assert.equal(u.email, 'a@x.io');
  assert.equal(await store.update('nope', { label: 'x' }), null);
});

test('concurrent upserts do not lose accounts', async () => {
  const store = new AccountStore(tmp());
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => store.upsert({ email: `${n}@x.io`, refreshToken: n })));
  assert.equal((await store.list()).length, 5);
});

test('publicAccount never exposes the refresh token', () => {
  assert.equal('refreshToken' in publicAccount({ id: '1', refreshToken: 'x', email: 'a@x.io' }), false);
});

const cfg = () => loadConfig({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', PORT: '8787', ALL_GMAIL_DATA_DIR: tmp() });

test('auth request uses PKCE, state, offline access and the narrowest Gmail scope', () => {
  const auth = new GoogleAuth(cfg());
  const { url, state } = auth.createAuthRequest({ loginHint: 'a@x.io' });
  const q = new URL(url).searchParams;
  assert.equal(q.get('scope'), 'https://www.googleapis.com/auth/gmail.modify');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('code_challenge').length >= 43);
  assert.equal(q.get('state'), state);
  assert.equal(q.get('login_hint'), 'a@x.io');
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:8787/auth/callback');
  assert.match(q.get('prompt'), /consent/);
});

test('oauth state is single use and expires', () => {
  const auth = new GoogleAuth(cfg());
  const { state } = auth.createAuthRequest();
  assert.ok(auth.consumeState(state));
  assert.equal(auth.consumeState(state), null);
  assert.equal(auth.consumeState('forged'), null);
  const { state: old } = auth.createAuthRequest();
  auth.pending.get(old).ts = Date.now() - 11 * 60 * 1000;
  assert.equal(auth.consumeState(old), null);
});

test('concurrent token requests share one refresh and the token is cached', async () => {
  let hits = 0;
  const fetchImpl = async () => {
    hits++;
    await new Promise((r) => setTimeout(r, 10));
    return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
  };
  const auth = new GoogleAuth(cfg(), { fetchImpl });
  const acc = { id: 'a1', refreshToken: 'rt' };
  const tokens = await Promise.all([auth.accessToken(acc), auth.accessToken(acc), auth.accessToken(acc)]);
  assert.deepEqual(tokens, ['at', 'at', 'at']);
  await auth.accessToken(acc);
  assert.equal(hits, 1);
});

test('invalid_grant becomes AuthError so the UI can ask to reconnect', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  const auth = new GoogleAuth(cfg(), { fetchImpl });
  await assert.rejects(() => auth.accessToken({ id: 'x', refreshToken: 'dead' }), (e) => e instanceof AuthError && e.code === 'reauth_required');
});
