// `npm run doctor`: checks everything that can go wrong before you sit through a browser login.
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { AccountStore } from './store.js';
import { MailService } from './service.js';

const portFree = (host, port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });

/** Returns [{ status: 'ok' | 'warn' | 'fail', title, detail?, fix? }]. Never throws. */
export async function runChecks({ config, service, anthropic, checkPort = true }) {
  const out = [];
  const add = (status, title, detail, fix) => out.push({ status, title, detail, fix });

  const major = Number(process.versions.node.split('.')[0]);
  major >= 22 ? add('ok', `Node ${process.versions.node}`) : add('fail', `Node ${process.versions.node} is too old`, 'This app needs Node 22 or newer.', 'Install a current Node from https://nodejs.org');

  const { clientId, clientSecret } = config.google;
  if (!clientId || !clientSecret) {
    add('fail', 'Google OAuth client is not configured', 'GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET are empty.', 'Run: npm run setup   (README section 1 explains how to get them)');
  } else {
    if (!/\.apps\.googleusercontent\.com$/.test(clientId) && !clientId.startsWith('fake')) {
      add('warn', 'GOOGLE_CLIENT_ID looks unusual', 'Real client IDs end in .apps.googleusercontent.com.', 'Copy the "Client ID" again from the Google Cloud console.');
    }
    try {
      const probe = await service.auth.probeClient();
      if (probe.ok === true) add('ok', 'Google accepts your client ID and secret');
      else if (probe.ok === false) add('fail', 'Google rejected your client ID or secret', probe.reason, 'Copy both values again from Google Cloud console > Clients. No spaces or quotes.');
      else add('warn', 'Could not confirm the Google client', probe.reason);
    } catch (err) {
      add('warn', 'Could not reach Google', err.cause?.code ?? err.message, 'Check your internet connection. Behind a proxy, start with NODE_USE_ENV_PROXY=1');
    }
  }

  try {
    await anthropic.models.retrieve(config.claude.model);
    add('ok', `Claude works (${config.claude.model})`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) add('fail', 'Anthropic rejected your API key', undefined, 'Create a new key at https://console.anthropic.com and run: npm run setup');
    else if (err instanceof Anthropic.NotFoundError) add('fail', `Model "${config.claude.model}" does not exist for your key`, undefined, 'Remove CLAUDE_MODEL from .env, or set a model you have access to.');
    else if (err instanceof Anthropic.APIConnectionError) add('warn', 'Could not reach the Claude API', undefined, 'Check your internet connection.');
    else if (/could not resolve authentication method/i.test(err?.message ?? '')) add('warn', 'No ANTHROPIC_API_KEY, so the Claude features are off', 'Mail still works without it.', 'Run: npm run setup');
    else add('warn', 'Could not check Claude', err?.message);
  }

  const accounts = await service.store.list();
  if (!accounts.length) {
    add('warn', 'No Gmail accounts connected yet', undefined, 'Start the app (npm start) and click "+ Add" for each account.');
  }
  for (const a of accounts) {
    const r = await service.listThreads({ view: 'inbox', accounts: [a.id], perAccount: 1 });
    if (!r.errors.length) add('ok', `${a.label} <${a.email}> can be read`);
    else if (r.errors[0].code === 'reauth_required') add('fail', `${a.label} <${a.email}> needs to be reconnected`, r.errors[0].message, 'Open the app and click "reconnect" next to that account.');
    else add('fail', `${a.label} <${a.email}> failed`, r.errors[0].message);
  }

  if (checkPort) {
    (await portFree(config.host, config.port))
      ? add('ok', `Port ${config.port} is free`)
      : add('warn', `Port ${config.port} is already in use`, 'The app may already be running, or another program uses the port.', 'Open http://127.0.0.1:' + config.port + ', or set PORT=<other> in .env.');
  }
  return out;
}

const ICON = { ok: '✓', warn: '!', fail: '✗' };

export function formatChecks(results) {
  const lines = [];
  for (const r of results) {
    lines.push(`${ICON[r.status]} ${r.title}`);
    if (r.detail) lines.push(`    ${r.detail}`);
    if (r.fix && r.status !== 'ok') lines.push(`    fix: ${r.fix}`);
  }
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  lines.push('', fails ? `${fails} problem(s) to fix.` : warns ? 'Ready, with a few notes above.' : 'All good.');
  return lines.join('\n');
}

export async function main(env = process.env) {
  const config = loadConfig(env);
  const service = new MailService({ config, store: new AccountStore(config.dataDir) });
  const results = await runChecks({ config, service, anthropic: new Anthropic() });
  console.log(formatChecks(results));
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
