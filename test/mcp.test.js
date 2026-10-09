import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WORK, setup } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function connect(t, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/mcp.js')],
    env: { ...process.env, ...t.fake.env, ALL_GMAIL_DATA_DIR: t.dir, ...extraEnv },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
}
const textOf = (r) => r.content.map((c) => c.text).join('');

test('MCP server: lists safe tools only, then searches, reads and drafts across accounts', async () => {
  const t = await setup();
  const client = await connect(t);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name).sort();
    assert.deepEqual(names, ['archive_thread', 'draft_reply', 'list_accounts', 'read_thread', 'search_mail']);
    assert.ok(!names.includes('send_draft'), 'sending must be off by default');
    assert.ok(tools.find((x) => x.name === 'search_mail').inputSchema.properties.query);

    const accounts = JSON.parse(textOf(await client.callTool({ name: 'list_accounts', arguments: {} })));
    assert.deepEqual(accounts.map((a) => a.label).sort(), ['leo.personal', 'leo.work', 'studio']);

    const found = textOf(await client.callTool({ name: 'search_mail', arguments: { query: 'renewal' } }));
    assert.match(found, /^<untrusted_email_content>/);
    assert.match(found, /Contract renewal/);
    assert.match(found, /"account":"leo\.work"/);

    const thread = textOf(await client.callTool({ name: 'read_thread', arguments: { account: 'leo.work', thread_id: 'wt1' } }));
    assert.match(thread, /95 EUR\/hour/);
    assert.match(thread, /<untrusted_email_content>/);

    const drafted = await client.callTool({ name: 'draft_reply', arguments: { account: 'leo.work', thread_id: 'wt1', body: 'Yes. Leo' } });
    assert.ok(!drafted.isError);
    assert.match(textOf(drafted), /NOT been sent/);
    assert.equal(t.drafts(WORK).length, 1);
    assert.equal(t.sent(WORK).length, 0);

    const bad = await client.callTool({ name: 'read_thread', arguments: { account: 'nobody', thread_id: 'x' } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /No account matches/);

    const archived = await client.callTool({ name: 'archive_thread', arguments: { account: 'leo.work', thread_id: 'wt3' } });
    assert.ok(!archived.isError);
  } finally {
    await client.close();
    await t.close();
  }
});

test('MCP server: send_draft exists only when explicitly enabled, and then really sends', async () => {
  const t = await setup();
  const client = await connect(t, { ALL_GMAIL_MCP_ALLOW_SEND: '1' });
  try {
    const { tools } = await client.listTools();
    const send = tools.find((x) => x.name === 'send_draft');
    assert.ok(send);
    assert.equal(send.annotations.destructiveHint, true);
    await client.callTool({ name: 'draft_reply', arguments: { account: 'leo.work', thread_id: 'wt1', body: 'Yes. Leo' } });
    const [draftId] = [...t.fake.state.accounts[WORK].drafts.keys()];
    const out = await client.callTool({ name: 'send_draft', arguments: { account: 'leo.work', draft_id: draftId } });
    assert.ok(!out.isError, textOf(out));
    assert.equal(t.sent(WORK).length, 1);
  } finally {
    await client.close();
    await t.close();
  }
});
