import crypto from 'node:crypto';

/** The refresh token is dead (revoked, expired, or password changed). The user must reconnect. */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.code = 'reauth_required';
  }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const STATE_TTL_MS = 10 * 60 * 1000;

export class GoogleAuth {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.cfg = config.google;
    this.redirectUri = `http://${config.host}:${config.port}/auth/callback`;
    this.fetch = fetchImpl;
    this.pending = new Map(); // state -> { verifier, ts }
    this.tokens = new Map(); // accountId -> { token, exp }
    this.inflight = new Map(); // accountId -> Promise
  }

  get configured() {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret);
  }

  /** Authorization Code flow with PKCE. Every state is single use and expires. */
  createAuthRequest({ loginHint } = {}) {
    for (const [s, v] of this.pending) if (Date.now() - v.ts > STATE_TTL_MS) this.pending.delete(s);
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    this.pending.set(state, { verifier, ts: Date.now() });
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: this.cfg.scope,
      access_type: 'offline',
      // consent forces a refresh token every time; select_account lets you pick which of your accounts.
      prompt: 'select_account consent',
      state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    if (loginHint) q.set('login_hint', loginHint);
    return { url: `${this.cfg.authUrl}?${q}`, state };
  }

  consumeState(state) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.ts > STATE_TTL_MS) return null;
    return p;
  }

  async #tokenRequest(params) {
    const res = await this.fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        ...params,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'invalid_grant') {
        throw new AuthError('Google no longer accepts this login. Reconnect the account.');
      }
      throw new Error(`Google token endpoint: ${data.error_description || data.error || res.status}`);
    }
    return data;
  }

  exchangeCode(code, verifier) {
    return this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
    });
  }

  async accessToken(account) {
    const cached = this.tokens.get(account.id);
    if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
    // Concurrent callers share one refresh.
    if (!this.inflight.has(account.id)) {
      const p = this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken })
        .then((d) => {
          this.tokens.set(account.id, { token: d.access_token, exp: Date.now() + d.expires_in * 1000 });
          return d.access_token;
        })
        .finally(() => this.inflight.delete(account.id));
      this.inflight.set(account.id, p);
    }
    return this.inflight.get(account.id);
  }

  invalidate(accountId) {
    this.tokens.delete(accountId);
  }
}
