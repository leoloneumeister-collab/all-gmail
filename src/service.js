import { AuthError, GoogleAuth } from './google-auth.js';
import { GmailClient, mapLimit } from './gmail.js';
import { buildRaw, parseMessage, quoteOriginal, replyDefaults } from './mime.js';
import { publicAccount } from './store.js';

export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

export const VIEWS = {
  inbox: 'in:inbox',
  unread: 'in:inbox is:unread',
  starred: 'is:starred',
  sent: 'in:sent',
  drafts: 'in:drafts',
  spam: 'in:spam',
  trash: 'in:trash',
  all: '',
};

const MODIFY = {
  read: { remove: ['UNREAD'] },
  unread: { add: ['UNREAD'] },
  archive: { remove: ['INBOX'] },
  unarchive: { add: ['INBOX'] },
  star: { add: ['STARRED'] },
  unstar: { remove: ['STARRED'] },
};

/**
 * The one place that knows how accounts, tokens and Gmail fit together.
 * The web server, the in-app Claude assistant and the MCP server all go through this class.
 */
export class MailService {
  constructor({ config, store, auth = new GoogleAuth(config), fetchImpl = fetch, retryDelayMs }) {
    this.config = config;
    this.store = store;
    this.auth = auth;
    this.fetch = fetchImpl;
    this.retryDelayMs = retryDelayMs;
    this.clients = new Map();
    this.needsReauth = new Set();
    this.summaryCache = new Map(); // "acct:thread:historyId" -> summary
  }

  // ---------- accounts ----------

  async accounts() {
    const list = await this.store.list();
    return list.map((a) => ({ ...publicAccount(a), needsReauth: this.needsReauth.has(a.id) }));
  }

  async resolve(ref) {
    const list = await this.store.list();
    const r = String(ref ?? '').trim().toLowerCase();
    const hit =
      list.find((a) => a.id === r) ||
      list.find((a) => a.email === r) ||
      list.find((a) => a.label.toLowerCase() === r) ||
      (r && list.filter((a) => a.email.includes(r) || a.label.toLowerCase().includes(r)).length === 1
        ? list.find((a) => a.email.includes(r) || a.label.toLowerCase().includes(r))
        : null);
    if (!hit) {
      const known = list.map((a) => `${a.label} <${a.email}>`).join(', ') || 'none connected';
      throw new ServiceError(404, 'unknown_account', `No account matches "${ref}". Connected: ${known}`);
    }
    return hit;
  }

  #client(account) {
    // Recreate when the stored token changed (account reconnected).
    let c = this.clients.get(account.id);
    if (!c || c.account.refreshToken !== account.refreshToken) {
      c = new GmailClient({
        account,
        auth: this.auth,
        baseUrl: this.config.google.gmailBase,
        fetchImpl: this.fetch,
        retryDelayMs: this.retryDelayMs,
      });
      this.clients.set(account.id, c);
    }
    return c;
  }

  /** Runs a Gmail call and keeps the reconnect flag in sync. */
  async #call(account, fn) {
    try {
      const out = await fn(this.#client(account));
      this.needsReauth.delete(account.id);
      return out;
    } catch (err) {
      if (err instanceof AuthError) this.needsReauth.add(account.id);
      throw err;
    }
  }

  async connect({ code, state }) {
    const pending = this.auth.consumeState(state);
    if (!pending) throw new ServiceError(400, 'bad_state', 'Login expired or was not started here. Try connecting again.');
    const tokens = await this.auth.exchangeCode(code, pending.verifier);
    if (!tokens.refresh_token) {
      throw new ServiceError(502, 'no_refresh_token', 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
    }
    const res = await this.fetch(`${this.config.google.gmailBase}/users/me/profile`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await res.json().catch(() => ({}));
    if (!res.ok || !profile.emailAddress) {
      throw new ServiceError(502, 'profile_failed', profile.error?.message || 'Could not read the Gmail profile for this login');
    }
    const account = await this.store.upsert({ email: profile.emailAddress, refreshToken: tokens.refresh_token });
    this.auth.tokens.set(account.id, { token: tokens.access_token, exp: Date.now() + tokens.expires_in * 1000 });
    this.needsReauth.delete(account.id);
    return publicAccount(account);
  }

  async updateAccount(ref, patch) {
    const acc = await this.resolve(ref);
    return publicAccount(await this.store.update(acc.id, patch));
  }

  async removeAccount(ref) {
    const acc = await this.resolve(ref);
    // Best effort: tell Google to drop the grant, then forget it locally either way.
    try {
      await this.fetch(`${this.config.google.revokeUrl}?token=${encodeURIComponent(acc.refreshToken)}`, { method: 'POST' });
    } catch {}
    await this.store.remove(acc.id);
    this.clients.delete(acc.id);
    this.needsReauth.delete(acc.id);
    return { id: acc.id, email: acc.email };
  }

  // ---------- reading ----------

  #summarize(account, t) {
    const msgs = (t.messages ?? []).map(parseMessage);
    const first = msgs[0];
    const last = msgs[msgs.length - 1];
    const labels = new Set(msgs.flatMap((m) => m.labelIds));
    const names = [];
    for (const m of msgs) {
      const n = m.sent ? 'me' : m.from.name || m.from.email;
      if (!names.includes(n)) names.push(n);
    }
    return {
      key: `${account.id}:${t.id}`,
      accountId: account.id,
      threadId: t.id,
      subject: first?.subject ?? '(no subject)',
      snippet: t.snippet ?? last?.snippet ?? '',
      from: last ? { name: last.sent ? 'me' : last.from.name, email: last.from.email } : { name: '', email: '' },
      participants: names,
      date: last?.date ?? null,
      internalDate: last?.internalDate ?? 0,
      unread: labels.has('UNREAD'),
      starred: labels.has('STARRED'),
      messageCount: msgs.length,
    };
  }

  /**
   * One merged, date-sorted list across accounts.
   * A broken account (revoked login, network) is reported in `errors`; the others still load.
   * Paging: pass back `nextTokens` as `pageTokens`. Only accounts with a token are fetched again.
   */
  async listThreads({ view = 'inbox', q = '', accounts: refs, perAccount = 20, pageTokens } = {}) {
    if (!(view in VIEWS)) throw new ServiceError(400, 'bad_view', `Unknown view "${view}"`);
    const all = await this.store.list();
    let targets = refs?.length ? await Promise.all(refs.map((r) => this.resolve(r))) : all;
    if (pageTokens) targets = targets.filter((a) => pageTokens[a.id]);
    const query = `${VIEWS[view]} ${q}`.trim();

    const settled = await Promise.all(
      targets.map(async (account) => {
        try {
          return await this.#call(account, async (gmail) => {
            const page = await gmail.listThreads({
              q: query,
              maxResults: perAccount,
              pageToken: pageTokens?.[account.id],
            });
            const threads = await mapLimit(page.threads ?? [], 8, async (item) => {
              const cacheKey = `${account.id}:${item.id}:${item.historyId}`;
              let s = this.summaryCache.get(cacheKey);
              if (!s) {
                const full = await gmail.getThread(item.id, 'metadata');
                s = this.#summarize(account, { ...full, snippet: item.snippet });
                this.summaryCache.set(cacheKey, s);
                if (this.summaryCache.size > 3000) this.summaryCache.delete(this.summaryCache.keys().next().value);
              }
              return s;
            });
            return { account, threads, next: page.nextPageToken ?? null };
          });
        } catch (err) {
          return { account, error: err };
        }
      }),
    );

    const threads = [];
    const nextTokens = {};
    const errors = [];
    for (const r of settled) {
      if (r.error) {
        errors.push({
          accountId: r.account.id,
          email: r.account.email,
          code: r.error.code ?? 'error',
          message: r.error.message,
        });
        continue;
      }
      threads.push(...r.threads);
      if (r.next) nextTokens[r.account.id] = r.next;
    }
    threads.sort((a, b) => b.internalDate - a.internalDate);
    return { threads, nextTokens, errors };
  }

  async getThread(ref, threadId) {
    const account = await this.resolve(ref);
    const thread = await this.#call(account, (g) => g.getParsedThread(threadId));
    const msgs = thread.messages;
    const target = [...msgs].reverse().find((m) => !m.sent && m.from.email !== account.email) ?? msgs[msgs.length - 1];
    const reply = target
      ? {
          messageId: target.id,
          single: replyDefaults(target, account.email),
          all: replyDefaults(target, account.email, { replyAll: true }),
        }
      : null;
    return { account: publicAccount(account), thread, reply };
  }

  async messageHtml(ref, messageId) {
    const account = await this.resolve(ref);
    const msg = await this.#call(account, (g) => g.getMessage(messageId, 'full'));
    return parseMessage(msg);
  }

  async attachment(ref, messageId, attachmentId) {
    const account = await this.resolve(ref);
    return this.#call(account, (g) => g.getAttachment(messageId, attachmentId));
  }

  // ---------- writing ----------

  async #prepare(ref, { to, cc, bcc, subject, body, threadId, replyToMessageId, includeQuote = true }) {
    const account = await this.resolve(ref);
    let inReplyTo;
    let references;
    let text = body ?? '';
    if (replyToMessageId) {
      const original = parseMessage(await this.#call(account, (g) => g.getMessage(replyToMessageId, 'full')));
      const d = replyDefaults(original, account.email);
      inReplyTo = d.inReplyTo;
      references = d.references;
      if (includeQuote) text = `${text}\n\n${quoteOriginal(original)}`;
    }
    const raw = buildRaw({ from: account.email, to, cc, bcc, subject, body: text, inReplyTo, references });
    return { account, raw, threadId };
  }

  async send(args) {
    const { account, raw, threadId } = await this.#prepare(args.account, args);
    const sent = await this.#call(account, (g) => g.sendRaw(raw, threadId));
    return { accountId: account.id, messageId: sent.id, threadId: sent.threadId };
  }

  async createDraft(args) {
    const { account, raw, threadId } = await this.#prepare(args.account, args);
    const draft = await this.#call(account, (g) => g.createDraft(raw, threadId));
    return { accountId: account.id, draftId: draft.id, threadId: draft.message?.threadId ?? threadId ?? null };
  }

  async sendDraft(ref, draftId) {
    const account = await this.resolve(ref);
    const sent = await this.#call(account, (g) => g.sendDraft(draftId));
    return { accountId: account.id, messageId: sent.id, threadId: sent.threadId };
  }

  /** Convenience used by Claude tools and MCP: draft a reply to the right person with the right headers. */
  async draftReply(ref, threadId, body, { replyAll = false } = {}) {
    const { account, thread, reply } = await this.getThread(ref, threadId);
    if (!reply) throw new ServiceError(404, 'empty_thread', 'This thread has no messages');
    const d = replyAll ? reply.all : reply.single;
    return this.createDraft({
      account: account.id,
      to: d.to,
      cc: d.cc,
      subject: d.subject,
      body,
      threadId,
      replyToMessageId: reply.messageId,
    });
  }

  async modifyThread(ref, threadId, action) {
    const account = await this.resolve(ref);
    if (action === 'trash') {
      await this.#call(account, (g) => g.trashThread(threadId));
      return { ok: true };
    }
    const m = MODIFY[action];
    if (!m) throw new ServiceError(400, 'bad_action', `Unknown action "${action}"`);
    await this.#call(account, (g) => g.modifyThread(threadId, m));
    // Cached summaries embed label state, drop them for this thread.
    for (const k of this.summaryCache.keys()) if (k.startsWith(`${account.id}:${threadId}:`)) this.summaryCache.delete(k);
    return { ok: true };
  }
}
