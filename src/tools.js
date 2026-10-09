import { z } from 'zod';
import { renderThread, untrusted } from './render.js';

/**
 * The mail tools Claude can use. One definition feeds both the in-app assistant and the MCP server.
 * None of them can send mail. Sending is a separate, opt-in tool that only the MCP server may expose.
 */
export const TOOL_SPECS = {
  list_accounts: {
    description: 'List the connected Gmail accounts (label and address).',
    input: z.object({}),
  },
  search_mail: {
    description:
      'Search threads across all connected Gmail accounts at once, or only the given ones. Uses Gmail search syntax (from:, subject:, is:unread, newer_than:7d, has:attachment ...). Newest first. Each hit says which account it belongs to.',
    input: z.object({
      query: z.string().describe('Gmail search query. Use an empty string for the latest inbox threads.'),
      accounts: z.array(z.string()).optional().describe('Account labels or addresses to limit the search to. Default: all.'),
      limit: z.number().int().min(1).max(25).optional().describe('Max threads, default 10.'),
    }),
  },
  read_thread: {
    description: 'Read all messages of one thread.',
    input: z.object({
      account: z.string().describe('Account label or address, as returned by search_mail.'),
      thread_id: z.string(),
    }),
  },
  draft_reply: {
    description: 'Create a reply DRAFT in the Gmail account that owns the thread, addressed correctly and threaded. It is never sent; the owner reviews it first.',
    input: z.object({
      account: z.string(),
      thread_id: z.string(),
      body: z.string().min(1).describe('Plain-text body of the reply, without a quoted original.'),
      reply_all: z.boolean().optional(),
    }),
  },
};

export function jsonSchemaFor(name) {
  const { $schema, ...schema } = z.toJSONSchema(TOOL_SPECS[name].input, { io: 'input' });
  return { ...schema, additionalProperties: false };
}

export const claudeToolDefs = () =>
  Object.entries(TOOL_SPECS).map(([name, spec]) => ({ name, description: spec.description, input_schema: jsonSchemaFor(name) }));

/** Handlers return plain text for the model. `draft_reply` also returns the draft so the UI can link to it. */
export function createMailTools(service) {
  return {
    async list_accounts() {
      const text = JSON.stringify((await service.accounts()).map((a) => ({ label: a.label, email: a.email, needs_reconnect: a.needsReauth })));
      return { text };
    },

    async search_mail({ query, accounts, limit = 10 }) {
      const r = await service.listThreads({ view: 'all', q: query, accounts, perAccount: limit });
      const all = await service.accounts();
      const rows = r.threads.slice(0, limit).map((t) => ({
        account: all.find((a) => a.id === t.accountId)?.label,
        thread_id: t.threadId,
        subject: t.subject,
        from: t.from.name || t.from.email,
        date: t.date,
        unread: t.unread,
        snippet: t.snippet,
      }));
      const problems = r.errors.map((e) => `${e.email}: ${e.message}`);
      return { text: `${untrusted(JSON.stringify(rows))}${problems.length ? `\nAccounts that could not be searched: ${problems.join('; ')}` : ''}` };
    },

    async read_thread({ account, thread_id }) {
      const r = await service.getThread(account, thread_id);
      return { text: untrusted(renderThread(r.account, r.thread, { maxChars: 20000 })) };
    },

    async draft_reply({ account, thread_id, body, reply_all }) {
      const draft = await service.draftReply(account, thread_id, body, { replyAll: reply_all });
      return { text: `Draft created in account ${draft.accountId} (draft id ${draft.draftId}). It has NOT been sent; the owner must review and send it.`, draft };
    },
  };
}
