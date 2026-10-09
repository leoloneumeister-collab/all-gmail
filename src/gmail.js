import { AuthError } from './google-auth.js';
import { parseMessage } from './mime.js';

export class GmailError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/** Thin Gmail REST client for one account. */
export class GmailClient {
  constructor({ account, auth, baseUrl, fetchImpl = fetch, retryDelayMs = 400 }) {
    this.account = account;
    this.auth = auth;
    this.base = baseUrl;
    this.fetch = fetchImpl;
    this.retryDelayMs = retryDelayMs;
  }

  async #request(method, path, { query, body } = {}) {
    const url = new URL(`${this.base}/users/me${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      for (const item of [].concat(v)) if (item !== undefined && item !== null && item !== '') url.searchParams.append(k, item);
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.accessToken(this.account);
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt < 3) {
          await sleep(this.retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new GmailError(0, `Network error talking to Gmail: ${err.message}`);
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.auth.invalidate(this.account.id);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || this.retryDelayMs * 2 ** attempt;
        await sleep(Math.min(wait, 10_000));
        continue;
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new AuthError('Gmail rejected the credentials. Reconnect the account.');
      if (!res.ok) throw new GmailError(res.status, data.error?.message || `Gmail returned ${res.status}`);
      return data;
    }
  }

  profile() {
    return this.#request('GET', '/profile');
  }

  listThreads({ q, labelIds, maxResults = 20, pageToken } = {}) {
    return this.#request('GET', '/threads', { query: { q, labelIds, maxResults, pageToken } });
  }

  getThread(id, format = 'full') {
    const query = { format };
    if (format === 'metadata') query.metadataHeaders = ['From', 'To', 'Subject', 'Date'];
    return this.#request('GET', `/threads/${encodeURIComponent(id)}`, { query });
  }

  async getParsedThread(id) {
    const t = await this.getThread(id, 'full');
    return { id: t.id, historyId: t.historyId, messages: (t.messages ?? []).map(parseMessage) };
  }

  getMessage(id, format = 'metadata') {
    const query = { format };
    if (format === 'metadata') query.metadataHeaders = ['Message-ID', 'References', 'In-Reply-To', 'Subject'];
    return this.#request('GET', `/messages/${encodeURIComponent(id)}`, { query });
  }

  async getAttachment(messageId, attachmentId) {
    const data = await this.#request(
      'GET',
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return Buffer.from(data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  modifyThread(id, { add = [], remove = [] }) {
    return this.#request('POST', `/threads/${encodeURIComponent(id)}/modify`, {
      body: { addLabelIds: add, removeLabelIds: remove },
    });
  }

  trashThread(id) {
    return this.#request('POST', `/threads/${encodeURIComponent(id)}/trash`);
  }

  sendRaw(raw, threadId) {
    return this.#request('POST', '/messages/send', { body: { raw, ...(threadId ? { threadId } : {}) } });
  }

  createDraft(raw, threadId) {
    return this.#request('POST', '/drafts', {
      body: { message: { raw, ...(threadId ? { threadId } : {}) } },
    });
  }

  sendDraft(draftId) {
    return this.#request('POST', '/drafts/send', { body: { id: draftId } });
  }
}
