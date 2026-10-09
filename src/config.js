import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env is optional. Real environment variables win over the file.
export const ENV_FILE = process.env.ALL_GMAIL_ENV_FILE || path.join(root, '.env');
try {
  process.loadEnvFile(ENV_FILE);
} catch {}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8787);
  return {
    root,
    host: '127.0.0.1',
    port,
    dataDir: path.resolve(env.ALL_GMAIL_DATA_DIR || path.join(root, 'data')),
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      revokeUrl: env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
      gmailBase: env.GMAIL_API_BASE || 'https://gmail.googleapis.com/gmail/v1',
      // gmail.modify covers read, label, draft and send. Nothing broader is requested.
      scope: 'https://www.googleapis.com/auth/gmail.modify',
    },
    claude: {
      model: env.CLAUDE_MODEL || 'claude-opus-5-5',
      fallbacks: env.CLAUDE_FALLBACKS !== '0',
      hasKey: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    },
    mcpAllowSend: env.ALL_GMAIL_MCP_ALLOW_SEND === '1',
  };
}
