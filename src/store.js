import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const PALETTE = ['#2f6fed', '#e0592a', '#2a9d6f', '#8e44ad', '#d4a017', '#d6336c'];

export function accountIdFor(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 8);
}

/** Strips secrets. This is the only shape that ever leaves the backend. */
export function publicAccount(a) {
  const { refreshToken, ...rest } = a;
  return rest;
}

/**
 * Accounts live in one JSON file, readable by the current user only.
 * Refresh tokens are the crown jewels here: anyone who can read this file can read your mail.
 */
export class AccountStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'accounts.json');
    this.queue = Promise.resolve();
  }

  async #read() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      return JSON.parse(raw).accounts ?? [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async #write(accounts) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  // Serialize read-modify-write cycles inside this process.
  #mutate(fn) {
    const run = this.queue.then(async () => {
      const accounts = await this.#read();
      const result = await fn(accounts);
      await this.#write(accounts);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  list() {
    return this.queue.then(() => this.#read());
  }

  async get(id) {
    return (await this.list()).find((a) => a.id === id) ?? null;
  }

  upsert({ email, refreshToken }) {
    return this.#mutate((accounts) => {
      const id = accountIdFor(email);
      let acc = accounts.find((a) => a.id === id);
      if (acc) {
        acc.refreshToken = refreshToken;
      } else {
        const used = new Set(accounts.map((a) => a.color));
        acc = {
          id,
          email: email.toLowerCase(),
          label: email.split('@')[0],
          color: PALETTE.find((c) => !used.has(c)) ?? PALETTE[accounts.length % PALETTE.length],
          persona: '',
          addedAt: new Date().toISOString(),
          refreshToken,
        };
        accounts.push(acc);
      }
      return { ...acc };
    });
  }

  update(id, patch) {
    const allowed = ['label', 'color', 'persona'];
    return this.#mutate((accounts) => {
      const acc = accounts.find((a) => a.id === id);
      if (!acc) return null;
      for (const key of allowed) {
        if (typeof patch[key] === 'string') acc[key] = patch[key].slice(0, key === 'persona' ? 2000 : 40);
      }
      return { ...acc };
    });
  }

  remove(id) {
    return this.#mutate((accounts) => {
      const i = accounts.findIndex((a) => a.id === id);
      if (i === -1) return false;
      accounts.splice(i, 1);
      return true;
    });
  }
}
