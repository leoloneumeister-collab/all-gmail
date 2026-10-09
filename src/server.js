import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { AccountStore } from './store.js';
import { MailService, ServiceError, VIEWS } from './service.js';
import { Assistant, ClaudeError } from './claude.js';
import { AuthError } from './google-auth.js';
import { GmailError } from './gmail.js';
import { InvalidMailError } from './mime.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const STATIC = new Set(['index.html', 'app.js', 'style.css', 'favicon.svg']);

const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SendBody = z.object({
  account: z.string().min(1),
  to: z.union([z.string(), z.array(z.string())]),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  bcc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().max(998),
  body: z.string().max(200_000),
  threadId: z.string().optional(),
  replyToMessageId: z.string().optional(),
  includeQuote: z.boolean().optional(),
});
const PatchBody = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  persona: z.string().max(2000).optional(),
});

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'Body is not valid JSON');
  }
}

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'bad_request', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function errorStatus(err) {
  if (err instanceof HttpError || err instanceof ServiceError || err instanceof ClaudeError || err instanceof InvalidMailError) return [err.status, err.code, err.message];
  if (err instanceof AuthError) return [401, 'reauth_required', err.message];
  if (err instanceof GmailError) return [[404, 403, 429].includes(err.status) ? err.status : 502, 'gmail_error', err.message];
  return [500, 'internal', 'Something went wrong on the server'];
}

export function createApp({ config, service, assistant }) {
  const publicDir = path.join(config.root, 'public');
  const server = http.createServer();

  const hosts = () => {
    const p = server.address()?.port ?? config.port;
    return { hosts: new Set([`127.0.0.1:${p}`, `localhost:${p}`]), origins: new Set([`http://127.0.0.1:${p}`, `http://localhost:${p}`]) };
  };

  const stripHtml = (m) => {
    const { html, ...rest } = m;
    return { ...rest, hasHtml: Boolean(html) };
  };

  const routes = [];
  const route = (method, pattern, handler) => routes.push([method, new RegExp(`^${pattern}$`), handler]);
  const dec = decodeURIComponent;

  // ---- pages and oauth ----
  route('GET', '/auth/start', async (req, res, _m, url) => {
    // A link on some other website must not be able to kick off a login here.
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'csrf', 'Cross-site navigation refused');
    if (!service.auth.configured) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': APP_CSP });
      return res.end('<!doctype html><meta charset=utf-8><body style="font:16px system-ui;max-width:560px;margin:60px auto"><h2>Google login is not configured</h2><p>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code> and restart. The README walks through it in about 5 minutes.</p><p><a href="/">Back</a></p>');
    }
    const { url: target } = service.auth.createAuthRequest({ loginHint: url.searchParams.get('hint') || undefined });
    res.writeHead(302, { location: target });
    res.end();
  });

  route('GET', '/auth/callback', async (req, res, _m, url) => {
    const back = (q) => {
      res.writeHead(302, { location: `/?${new URLSearchParams(q)}` });
      res.end();
    };
    if (url.searchParams.get('error')) return back({ error: `Google: ${url.searchParams.get('error')}` });
    try {
      const acc = await service.connect({ code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? '' });
      back({ connected: acc.email });
    } catch (err) {
      back({ error: errorStatus(err)[2] });
    }
  });

  // ---- accounts ----
  route('GET', '/api/state', async (req, res) => {
    json(res, 200, {
      accounts: await service.accounts(),
      googleConfigured: service.auth.configured,
      claude: { model: config.claude.model, hasKey: config.claude.hasKey },
      views: Object.keys(VIEWS),
    });
  });
  route('PATCH', '/api/accounts/([^/]+)', async (req, res, m) => {
    json(res, 200, await service.updateAccount(dec(m[1]), parse(PatchBody, await readJson(req))));
  });
  route('DELETE', '/api/accounts/([^/]+)', async (req, res, m) => json(res, 200, await service.removeAccount(dec(m[1]))));

  // ---- mail ----
  route('GET', '/api/threads', async (req, res, _m, url) => {
    const q = url.searchParams;
    let pageTokens;
    if (q.get('tokens')) {
      try {
        pageTokens = JSON.parse(q.get('tokens'));
      } catch {
        throw new HttpError(400, 'bad_request', 'tokens must be JSON');
      }
    }
    json(res, 200, await service.listThreads({
      view: q.get('view') || 'inbox',
      q: q.get('q') || '',
      accounts: q.get('accounts') ? q.get('accounts').split(',') : undefined,
      perAccount: Math.min(Number(q.get('perAccount')) || 20, 50),
      pageTokens,
    }));
  });
  route('GET', '/api/threads/([^/]+)/([^/]+)', async (req, res, m) => {
    const { account, thread, reply } = await service.getThread(dec(m[1]), dec(m[2]));
    json(res, 200, { account, thread: { ...thread, messages: thread.messages.map(stripHtml) }, reply });
  });
  route('POST', '/api/threads/([^/]+)/([^/]+)/(read|unread|archive|unarchive|star|unstar|trash)', async (req, res, m) => {
    json(res, 200, await service.modifyThread(dec(m[1]), dec(m[2]), m[3]));
  });
  route('POST', '/api/send', async (req, res) => {
    const b = parse(SendBody, await readJson(req));
    json(res, 200, await service.send(b));
  });
  route('POST', '/api/drafts', async (req, res) => {
    const b = parse(SendBody, await readJson(req));
    json(res, 200, await service.createDraft(b));
  });

  // HTML mail is only ever shown inside a script-less, network-less sandbox. Remote images are opt-in.
  route('GET', '/api/body/([^/]+)/([^/]+)', async (req, res, m, url) => {
    const msg = await service.messageHtml(dec(m[1]), dec(m[2]));
    const images = url.searchParams.get('images') === '1';
    const cleaned = msg.html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<(iframe|object|embed|form)[\s\S]*?(<\/\1>|\/>)/gi, '');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'SAMEORIGIN',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; img-src data: ${images ? 'https: http:' : ''}; style-src 'unsafe-inline'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox`,
    });
    res.end(`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:12px;background:#fff;color:#1f2328;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#1a56db}</style>${cleaned}`);
  });
  route('GET', '/api/attachment/([^/]+)/([^/]+)/([^/]+)', async (req, res, m, url) => {
    const buf = await service.attachment(dec(m[1]), dec(m[2]), dec(m[3]));
    const name = (url.searchParams.get('filename') || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    res.writeHead(200, {
      'content-type': 'application/octet-stream', // never let the browser render attacker-supplied types
      'content-disposition': `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff',
      'content-length': buf.length,
    });
    res.end(buf);
  });

  // ---- claude ----
  route('POST', '/api/claude/summarize', async (req, res) => {
    const b = parse(z.object({ account: z.string(), threadId: z.string() }), await readJson(req));
    json(res, 200, { summary: await assistant.summarize(b.account, b.threadId) });
  });
  route('POST', '/api/claude/draft', async (req, res) => {
    const b = parse(z.object({ account: z.string(), threadId: z.string(), instruction: z.string().max(4000).optional(), replyAll: z.boolean().optional() }), await readJson(req));
    json(res, 200, await assistant.draftReply(b.account, b.threadId, b));
  });
  route('POST', '/api/claude/triage', async (req, res) => {
    const b = parse(z.object({ view: z.string().optional(), q: z.string().optional(), accounts: z.array(z.string()).optional() }), await readJson(req));
    json(res, 200, await assistant.triage(b));
  });
  route('POST', '/api/claude/chat', async (req, res) => {
    const b = parse(
      z.object({
        messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1),
        context: z.object({ accountId: z.string(), threadId: z.string() }).optional(),
      }),
      await readJson(req, 500_000),
    );
    json(res, 200, await assistant.chat(b.messages, { context: b.context }));
  });

  async function serveStatic(res, name) {
    if (!STATIC.has(name)) throw new HttpError(404, 'not_found', 'Not found');
    const data = await fs.readFile(path.join(publicDir, name));
    res.writeHead(200, {
      'content-type': MIME[path.extname(name)] ?? 'application/octet-stream',
      'content-security-policy': APP_CSP,
      'cache-control': 'no-store',
    });
    res.end(data);
  }

  server.on('request', async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (!res.hasHeader('x-frame-options')) res.setHeader('x-frame-options', 'DENY');
    try {
      const { hosts: okHosts, origins } = hosts();
      // DNS rebinding: a hostile site pointing its own domain at 127.0.0.1 would send a different Host header.
      if (!okHosts.has(req.headers.host ?? '')) throw new HttpError(403, 'bad_host', 'Unexpected Host header');
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mutating = !['GET', 'HEAD'].includes(req.method);
      if (mutating) {
        // CSRF: a custom header forces a CORS preflight, which this server never grants. Origin is checked as well.
        if (req.headers['x-all-gmail'] !== '1') throw new HttpError(403, 'csrf', 'Missing X-All-Gmail header');
        if (req.headers.origin && !origins.has(req.headers.origin)) throw new HttpError(403, 'csrf', 'Cross-origin request refused');
      }
      for (const [method, re, handler] of routes) {
        const m = url.pathname.match(re);
        if (m && method === req.method) return await handler(req, res, m, url);
      }
      if (req.method === 'GET' && (url.pathname === '/' || STATIC.has(url.pathname.slice(1)))) {
        return await serveStatic(res, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      }
      throw new HttpError(404, 'not_found', 'Not found');
    } catch (err) {
      const [status, code, message] = errorStatus(err);
      if (status >= 500) console.error(err);
      if (res.headersSent) return res.end();
      json(res, status, { error: { code, message } });
    }
  });

  return server;
}

export async function start(env = process.env) {
  const config = loadConfig(env);
  const store = new AccountStore(config.dataDir);
  const service = new MailService({ config, store });
  const assistant = new Assistant({ service, config });
  const server = createApp({ config, service, assistant });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is busy. Set PORT=<other> in .env (and update the redirect URI if you use a Web client).`);
      reject(err);
    });
    server.listen(config.port, config.host, resolve);
  });
  const accounts = await service.accounts();
  console.log(`All Gmail running at http://${config.host}:${config.port}`);
  console.log(`  accounts connected: ${accounts.length} ${accounts.map((a) => a.label).join(', ')}`);
  if (!service.auth.configured) console.log('  Google login not configured yet: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (see README).');
  if (!config.claude.hasKey) console.log('  Claude not configured: set ANTHROPIC_API_KEY in .env to use the AI features.');
  return { server, config, service, assistant };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
