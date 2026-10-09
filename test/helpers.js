import fs from 'node:fs';
import { after } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { createFakeGoogle, signIn, FAKE_ACCOUNTS } from '../scripts/fake-google.js';
import { loadConfig } from '../src/config.js';
import { AccountStore } from '../src/store.js';
import { MailService } from '../src/service.js';
import { Assistant } from '../src/claude.js';
import { createApp } from '../src/server.js';

// Servers left open by a failing assertion would keep the test process alive, so always clean up.
const openSetups = new Set();
after(async () => {
  for (const s of [...openSetups]) await s.close().catch(() => {});
});

export const [WORK, PERSONAL, STUDIO] = FAKE_ACCOUNTS.map((a) => a.email);

/** Stands in for the Anthropic SDK client. `script` is an array of responses or a function (params, n) => response. */
export class FakeAnthropic {
  constructor(script = []) {
    this.script = script;
    this.calls = [];
    const create = async (params) => {
      this.calls.push(structuredClone(params)); // the real SDK serializes immediately; later mutation must not show up here
      const next = typeof this.script === 'function' ? this.script(params, this.calls.length) : this.script.shift();
      if (!next) throw new Error('FakeAnthropic: script exhausted');
      if (next instanceof Error) throw next;
      return next;
    };
    this.messages = { create };
    this.beta = { messages: { create } };
  }
}

export const reply = {
  text: (text, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra }),
  json: (obj) => reply.text(JSON.stringify(obj)),
  tools: (...uses) => ({
    stop_reason: 'tool_use',
    content: uses.map(([name, input], i) => ({ type: 'tool_use', id: `tu_${name}_${i}`, name, input })),
  }),
  refusal: () => ({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms' }, content: [] }),
};

export async function setup({ script = [], connect = [WORK, PERSONAL, STUDIO], env = {} } = {}) {
  const fake = await createFakeGoogle();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'all-gmail-test-'));
  const config = loadConfig({ ...fake.env, ALL_GMAIL_DATA_DIR: dir, PORT: '0', ...env });
  const store = new AccountStore(dir);
  const service = new MailService({ config, store, retryDelayMs: 1 });
  const client = new FakeAnthropic(script);
  const assistant = new Assistant({ service, config, client });
  const server = createApp({ config, service, assistant });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const accounts = {};
  for (const email of connect) accounts[email] = await signIn(service, email);

  async function call(p, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { ...(method !== 'GET' ? { 'x-all-gmail': '1', 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  }

  const result = {
    fake, dir, config, store, service, assistant, client, server, port, accounts, call,
    sent: (email) => fake.state.accounts[email].sent,
    drafts: (email) => [...fake.state.accounts[email].drafts.values()],
    async close() {
      if (!openSetups.delete(result)) return;
      server.closeAllConnections?.();
      fake.server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  openSetups.add(result);
  return result;
}
