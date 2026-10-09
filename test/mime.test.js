import test from 'node:test';
import assert from 'node:assert/strict';
import { b64urlDecode, b64urlEncode, buildRaw, htmlToText, parseAddress, parseAddressList, parseMessage, quoteOriginal, replyDefaults } from '../src/mime.js';

const enc = (s) => b64urlEncode(Buffer.from(s));
const decodeRaw = (raw) => {
  const text = b64urlDecode(raw).toString('utf8');
  const [head, body] = text.split('\r\n\r\n');
  return { head, body: Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8'), text };
};

test('parseAddress handles names, quotes and bare addresses', () => {
  assert.deepEqual(parseAddress('Ada Lovelace <ADA@Example.com>'), { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.deepEqual(parseAddress('"Doe, John" <j@x.io>'), { name: 'Doe, John', email: 'j@x.io' });
  assert.deepEqual(parseAddress('plain@x.io'), { name: '', email: 'plain@x.io' });
});

test('parseAddressList does not split on commas inside quotes', () => {
  const list = parseAddressList('"Doe, John" <j@x.io>, b@y.io, Carol <c@z.io>');
  assert.deepEqual(list.map((a) => a.email), ['j@x.io', 'b@y.io', 'c@z.io']);
  assert.equal(list[0].name, 'Doe, John');
});

test('htmlToText strips markup, scripts and decodes entities', () => {
  const t = htmlToText('<style>p{}</style><p>Hello&nbsp;<b>world</b> &amp; &#169; &lt;3</p><script>evil()</script><br>Bye');
  assert.equal(t, 'Hello world & © <3\n\nBye');
});

test('parseMessage walks multipart trees and decodes non-UTF-8 charsets', () => {
  const msg = {
    id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], internalDate: '1700000000000', snippet: 's',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'A <a@x.io>' }, { name: 'To', value: 'b@x.io, c@x.io' }, { name: 'Subject', value: 'Hi' }, { name: 'Message-ID', value: '<1@x>' }],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }], body: { data: b64urlEncode(Buffer.from('Gr\xfc\xdfe', 'latin1')) } },
            { mimeType: 'text/html', body: { data: enc('<p>Hi</p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'att1', size: 10 } },
      ],
    },
  };
  const m = parseMessage(msg);
  assert.equal(m.text, 'Grüße');
  assert.equal(m.html, '<p>Hi</p>');
  assert.equal(m.unread, true);
  assert.deepEqual(m.attachments, [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 10, attachmentId: 'att1' }]);
  assert.deepEqual(m.to.map((a) => a.email), ['b@x.io', 'c@x.io']);
});

test('parseMessage falls back to html-as-text when there is no plain part', () => {
  const m = parseMessage({ id: '1', payload: { mimeType: 'text/html', headers: [], body: { data: enc('<div>Only html</div>') } } });
  assert.equal(m.text, 'Only html');
});

test('buildRaw produces threaded UTF-8 mail with an encoded subject', () => {
  const raw = buildRaw({ from: 'me@x.io', to: ['Ann <ann@y.io>'], cc: 'bob@y.io', subject: 'Grüße ✓', body: 'Zeile 1\nZeile 2 ✓', inReplyTo: '<a@x>', references: '<z@x> <a@x>' });
  const { head, body } = decodeRaw(raw);
  assert.match(head, /^From: me@x\.io/m);
  assert.match(head, /^To: Ann <ann@y\.io>/m);
  assert.match(head, /^Cc: bob@y\.io/m);
  assert.match(head, /^In-Reply-To: <a@x>/m);
  assert.match(head, /^References: <z@x> <a@x>/m);
  const subj = head.match(/^Subject: (.*)$/m)[1];
  assert.match(subj, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(subj.match(/\?B\?(.*)\?=/)[1], 'base64').toString('utf8'), 'Grüße ✓');
  assert.equal(body, 'Zeile 1\r\nZeile 2 ✓');
});

test('buildRaw refuses header injection and bad recipients', () => {
  assert.throws(() => buildRaw({ from: 'me@x.io', to: 'a@y.io', subject: 'Hi\r\nBcc: evil@z.io', body: 'x' }), /line breaks/);
  assert.throws(() => buildRaw({ from: 'me@x.io', to: 'a@y.io\r\nBcc: evil@z.io', subject: 's', body: 'x' }), /line breaks|Invalid/);
  assert.throws(() => buildRaw({ from: 'me@x.io', to: 'not-an-address', subject: 's', body: 'x' }), /Invalid email/);
  assert.throws(() => buildRaw({ from: 'me@x.io', to: [], subject: 's', body: 'x' }), /recipient/);
  assert.throws(() => buildRaw({ from: 'me@x.io', to: 'a@y.io', subject: 's', body: 'x', inReplyTo: '<a>\nBcc: z@z.io' }), /line breaks/);
});

const incoming = {
  id: 'm', from: { name: 'Tom', email: 'tom@x.io' }, to: [{ name: '', email: 'me@x.io' }, { name: 'Nina', email: 'nina@x.io' }],
  cc: [{ name: '', email: 'cc@x.io' }], replyTo: [], subject: 'Plan', messageId: '<m@x>', references: '<r@x>', text: 'Line one\nLine two',
  internalDate: 1700000000000, date: '2023-11-14T22:13:20.000Z',
};

test('replyDefaults: plain reply goes to the sender, reply-all adds the others but never me', () => {
  const one = replyDefaults(incoming, 'me@x.io');
  assert.deepEqual(one.to, ['Tom <tom@x.io>']);
  assert.deepEqual(one.cc, []);
  assert.equal(one.subject, 'Re: Plan');
  assert.equal(one.inReplyTo, '<m@x>');
  assert.equal(one.references, '<r@x> <m@x>');
  const all = replyDefaults(incoming, 'ME@x.io', { replyAll: true });
  assert.deepEqual(all.cc, ['Nina <nina@x.io>', 'cc@x.io']);
});

test('replyDefaults: honours Reply-To, keeps an existing Re:, handles replying to own message', () => {
  const rt = replyDefaults({ ...incoming, replyTo: [{ name: '', email: 'list@x.io' }], subject: 'Re: Plan' }, 'me@x.io');
  assert.deepEqual(rt.to, ['list@x.io']);
  assert.equal(rt.subject, 'Re: Plan');
  const own = replyDefaults({ ...incoming, from: { name: '', email: 'me@x.io' }, to: [{ name: 'Ann', email: 'ann@y.io' }] }, 'me@x.io');
  assert.deepEqual(own.to, ['Ann <ann@y.io>']);
});

test('quoteOriginal prefixes every line', () => {
  const q = quoteOriginal(incoming);
  assert.match(q, /^On .*Tom <tom@x\.io> wrote:\n> Line one\n> Line two$/);
});
