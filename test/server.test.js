import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { b64urlEncode } from '../src/mime.js';
import { WORK, PERSONAL, setup, reply } from './helpers.js';

const rawGet = (port, path, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end();
  });

test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
  const t = await setup();
  const evil = await rawGet(t.port, '/api/state', { host: `attacker.example:${t.port}` });
  assert.equal(evil.status, 403);
  const rebind = await rawGet(t.port, '/api/state', { host: `127.0.0.1.attacker.example:${t.port}` });
  assert.equal(rebind.status, 403);
  const ok = await rawGet(t.port, '/api/state', { host: `localhost:${t.port}` });
  assert.equal(ok.status, 200);
  await t.close();
});

test('state-changing requests need the custom header and a same-origin Origin (CSRF)', async () => {
  const t = await setup();
  const body = JSON.stringify({ label: 'Hacked' });
  const bare = await fetch(`http://127.0.0.1:${t.port}/api/accounts/work`, { method: 'PATCH', headers: { 'content-type': 'text/plain' }, body });
  assert.equal(bare.status, 403);
  const foreign = await t.call('/api/accounts/work', { method: 'PATCH', body: { label: 'Hacked' }, headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.equal((await t.service.resolve('work')).label, 'leo.work');
  const same = await t.call('/api/accounts/work', { method: 'PATCH', body: { label: 'Work' }, headers: { origin: `http://127.0.0.1:${t.port}` } });
  assert.equal(same.status, 200);
  assert.equal(same.body.label, 'Work');
  await t.close();
});

test('the app page ships a strict CSP and no secrets leave through /api/state', async () => {
  const t = await setup();
  const page = await t.call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.ok(!/<script>[^<]/.test(page.body), 'no inline scripts');
  const state = await t.call('/api/state');
  assert.equal(state.body.accounts.length, 3);
  assert.ok(!JSON.stringify(state.body).includes('rt-'), 'refresh token leaked');
  assert.ok(!JSON.stringify(state.body).includes('refreshToken'));
  await t.close();
});

test('only whitelisted static files are served', async () => {
  const t = await setup();
  for (const p of ['/src/config.js', '/package.json', '/.env', '/data/accounts.json', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/package.json']) {
    const r = await t.call(p);
    assert.equal(r.status, 404, p);
  }
  assert.equal((await t.call('/app.js')).status, 200);
  await t.close();
});

test('thread list and thread view work end to end, html is never inlined in JSON', async () => {
  const t = await setup();
  const list = await t.call('/api/threads?view=inbox');
  assert.equal(list.status, 200);
  assert.equal(list.body.threads.length, 11);
  const stripe = list.body.threads.find((x) => x.subject.includes('invoice'));
  const one = await t.call(`/api/threads/${stripe.accountId}/${stripe.threadId}`);
  assert.equal(one.status, 200);
  const m = one.body.thread.messages[0];
  assert.equal(m.hasHtml, true);
  assert.equal('html' in m, false);
  assert.ok(one.body.reply.single.to[0].includes('receipts@stripe.com'));
  const bad = await t.call('/api/threads/zzz/abc');
  assert.equal(bad.status, 404);
  assert.equal(bad.body.error.code, 'unknown_account');
  await t.close();
});

test('HTML mail renders only inside a script-less, network-less sandbox; remote images are opt-in', async () => {
  const t = await setup();
  const evil = {
    id: 'ev1', threadId: 'evt', labelIds: ['INBOX'], snippet: 'x', internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/html',
      headers: [{ name: 'From', value: 'x <x@y.io>' }, { name: 'To', value: WORK }, { name: 'Subject', value: 'evil' }],
      body: { data: b64urlEncode('<p>hello</p><script>alert(1)</script><iframe src="https://x.io"></iframe><img src="https://tracker.example/p.gif">') },
    },
  };
  t.fake.state.accounts[WORK].threads.set('evt', [evil]);
  const id = t.accounts[WORK].id;
  const blocked = await t.call(`/api/body/${id}/ev1`);
  const csp = blocked.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox/);
  assert.ok(!/https:/.test(csp), 'remote images must be off by default');
  assert.ok(!/allow-scripts/.test(csp));
  assert.ok(blocked.body.includes('<p>hello</p>'));
  assert.ok(!/<script/i.test(blocked.body));
  assert.ok(!/<iframe/i.test(blocked.body));
  const opted = await t.call(`/api/body/${id}/ev1?images=1`);
  assert.match(opted.headers.get('content-security-policy'), /img-src data: https: http:/);
  await t.close();
});

test('attachments download as opaque binary, whatever type the sender claimed', async () => {
  const t = await setup();
  const id = t.accounts[WORK].id;
  const r = await t.call(`/api/attachment/${id}/w1/att-w1-0?filename=${encodeURIComponent('../../evil".html')}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="[\w.\- ]+"$/);
  assert.ok(!r.headers.get('content-disposition').includes('/'));
  assert.equal(r.body, '%PDF-1.4 fake');
  await t.close();
});

test('sending through the API uses the chosen account and validates input', async () => {
  const t = await setup();
  const ok = await t.call('/api/send', { method: 'POST', body: { account: 'personal', to: 'sophie.martin@example.org', subject: 'Re: Dinner on Saturday?', body: 'Sounds great!', threadId: 'pt1', replyToMessageId: 'p1' } });
  assert.equal(ok.status, 200);
  assert.equal(t.sent(PERSONAL).length, 1);
  assert.equal(t.sent(WORK).length, 0);
  const bad = await t.call('/api/send', { method: 'POST', body: { account: 'work' } });
  assert.equal(bad.status, 400);
  const invalid = await t.call('/api/send', { method: 'POST', body: { account: 'work', to: 'nope', subject: 's', body: 'b' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_mail');
  assert.equal(invalid.body.error.message, 'Invalid email address: nope');
  assert.equal(t.sent(WORK).length, 0);
  await t.close();
});

test('oauth routes: start redirects to Google, a forged callback is rejected, setup help shows when unconfigured', async () => {
  const t = await setup({ connect: [] });
  const start = await t.call('/auth/start?hint=a@x.io');
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, `${t.fake.base}/auth`);
  assert.equal(loc.searchParams.get('login_hint'), 'a@x.io');
  const crossSite = await t.call('/auth/start', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const typed = await t.call('/auth/start', { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(typed.status, 302);
  const forged = await t.call('/auth/callback?code=abc&state=forged');
  assert.equal(forged.status, 302);
  assert.match(forged.headers.get('location'), /^\/\?error=/);
  await t.close();

  const bare = await setup({ connect: [], env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
  const help = await bare.call('/auth/start');
  assert.equal(help.status, 200);
  assert.match(help.body, /not configured/);
  assert.equal((await bare.call('/api/state')).body.googleConfigured, false);
  await bare.close();
});

test('claude routes are wired to the assistant', async () => {
  const t = await setup({ script: [reply.text('One line gist\n- first\n- second')] });
  const r = await t.call('/api/claude/summarize', { method: 'POST', body: { account: 'work', threadId: 'wt1' } });
  assert.equal(r.status, 200);
  assert.match(r.body.summary, /gist/);
  const bad = await t.call('/api/claude/chat', { method: 'POST', body: { messages: [] } });
  assert.equal(bad.status, 400);
  await t.close();
});
