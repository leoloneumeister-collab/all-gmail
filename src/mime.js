// Everything about turning Gmail API payloads into plain objects and back into RFC 2822 mail.

/** The user (or Claude) asked for a message that cannot be built. Safe to show as-is. */
export class InvalidMailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidMailError';
    this.status = 400;
    this.code = 'invalid_mail';
  }
}

export const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
export const b64urlEncode = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const EMAIL_RE = /^[^\s<>@,;"()[\]\\]+@[^\s<>@,;"()[\]\\]+\.[^\s<>@,;"()[\]\\]+$/;
export const isEmail = (s) => EMAIL_RE.test(String(s).trim());

export function headerValue(headers = [], name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/** "Ada L <ada@x.com>" -> { name: "Ada L", email: "ada@x.com" } */
export function parseAddress(str = '') {
  const s = String(str).trim();
  const m = s.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: s.replace(/^<|>$/g, '').trim().toLowerCase() };
}

/** Splits on commas that are outside quotes and angle brackets. */
export function parseAddressList(str = '') {
  const out = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (const ch of String(str)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && angle === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(parseAddress).filter((a) => a.email);
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function htmlToText(html = '') {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodePart(part) {
  const data = part.body?.data;
  if (!data) return '';
  const ct = headerValue(part.headers, 'content-type');
  const charset = (ct.match(/charset="?([^";\s]+)"?/i) || [])[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(b64urlDecode(data));
  } catch {
    return b64urlDecode(data).toString('utf8');
  }
}

function walk(part, out) {
  const mime = (part.mimeType || '').toLowerCase();
  if (part.filename || (part.body?.attachmentId && !mime.startsWith('multipart/'))) {
    out.attachments.push({
      filename: part.filename || 'attachment',
      mimeType: part.mimeType,
      size: part.body?.size ?? 0,
      attachmentId: part.body?.attachmentId ?? null,
    });
    return;
  }
  if (mime === 'text/plain') out.text += decodePart(part);
  else if (mime === 'text/html') out.html += decodePart(part);
  for (const p of part.parts ?? []) walk(p, out);
}

/** Gmail API message resource -> flat object the UI, Claude and MCP tools all share. */
export function parseMessage(msg) {
  const h = msg.payload?.headers ?? [];
  const out = { text: '', html: '', attachments: [] };
  if (msg.payload) walk(msg.payload, out);
  const labelIds = msg.labelIds ?? [];
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds,
    unread: labelIds.includes('UNREAD'),
    sent: labelIds.includes('SENT'),
    snippet: msg.snippet ?? '',
    internalDate: Number(msg.internalDate ?? 0),
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : headerValue(h, 'date'),
    from: parseAddress(headerValue(h, 'from')),
    to: parseAddressList(headerValue(h, 'to')),
    cc: parseAddressList(headerValue(h, 'cc')),
    replyTo: parseAddressList(headerValue(h, 'reply-to')),
    subject: headerValue(h, 'subject') || '(no subject)',
    messageId: headerValue(h, 'message-id'),
    references: headerValue(h, 'references'),
    text: out.text || htmlToText(out.html),
    html: out.html,
    attachments: out.attachments,
  };
}

// ---------- building outgoing mail ----------

export function assertNoLineBreaks(value, field) {
  if (/[\r\n]/.test(String(value))) throw new InvalidMailError(`Invalid ${field}: line breaks are not allowed`);
  return String(value);
}

const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

function formatAddress({ name, email }) {
  assertNoLineBreaks(email, 'address');
  if (!isEmail(email)) throw new InvalidMailError(`Invalid email address: ${email}`);
  if (!name) return email;
  assertNoLineBreaks(name, 'address name');
  return /^[\w .'-]+$/.test(name) ? `${name} <${email}>` : `${encodeWord(name)} <${email}>`;
}

const toAddresses = (list) =>
  (Array.isArray(list) ? list : parseAddressList(list ?? '')).map((a) =>
    typeof a === 'string' ? parseAddress(a) : a,
  );

/** Returns the base64url "raw" string Gmail's send and drafts endpoints expect. */
export function buildRaw({ from, to, cc, bcc, subject, body, inReplyTo, references }) {
  const toList = toAddresses(to);
  if (!toList.length) throw new InvalidMailError('At least one recipient is required');
  const lines = [
    `From: ${formatAddress(typeof from === 'string' ? { name: '', email: from } : from)}`,
    `To: ${toList.map(formatAddress).join(', ')}`,
  ];
  const ccList = toAddresses(cc);
  if (ccList.length) lines.push(`Cc: ${ccList.map(formatAddress).join(', ')}`);
  const bccList = toAddresses(bcc);
  if (bccList.length) lines.push(`Bcc: ${bccList.map(formatAddress).join(', ')}`);
  lines.push(`Subject: ${encodeWord(assertNoLineBreaks(subject ?? '', 'subject'))}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${assertNoLineBreaks(inReplyTo, 'In-Reply-To')}`);
  if (references) lines.push(`References: ${assertNoLineBreaks(references, 'References')}`);
  lines.push(
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(body ?? '').replace(/\r?\n/g, '\r\n'), 'utf8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n'),
  );
  return b64urlEncode(lines.join('\r\n'));
}

const dedupe = (list) => {
  const seen = new Set();
  return list.filter((a) => a.email && !seen.has(a.email) && seen.add(a.email));
};

/**
 * Sensible reply defaults for the message being answered.
 * `message` is a parsed message, `myEmail` the account that will send.
 */
export function replyDefaults(message, myEmail, { replyAll = false } = {}) {
  const me = myEmail.toLowerCase();
  const fromMe = message.from.email === me;
  const primary = fromMe ? message.to : message.replyTo.length ? message.replyTo : [message.from];
  let to = dedupe(primary.filter((a) => a.email !== me || fromMe));
  let cc = [];
  if (replyAll) {
    const others = dedupe([...message.to, ...message.cc]).filter(
      (a) => a.email !== me && !to.some((t) => t.email === a.email),
    );
    cc = others;
  }
  if (!to.length) to = [message.from];
  const subject = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`;
  const refs = [message.references, message.messageId].filter(Boolean).join(' ').trim();
  return {
    to: to.map(formatAddr),
    cc: cc.map(formatAddr),
    subject,
    inReplyTo: message.messageId,
    references: refs.length > 900 ? refs.slice(-900).replace(/^\S*\s/, '') : refs,
  };
}

const formatAddr = (a) => (a.name ? `${a.name} <${a.email}>` : a.email);

export function quoteOriginal(message) {
  const who = message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email;
  const when = new Date(message.internalDate || message.date).toUTCString();
  const quoted = message.text
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');
  return `On ${when}, ${who} wrote:\n${quoted}`;
}
