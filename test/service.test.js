import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from '../src/google-auth.js';
import { GmailError } from '../src/gmail.js';
import { ServiceError } from '../src/service.js';
import { signIn } from '../scripts/fake-google.js';
import { PERSONAL, STUDIO, WORK, setup } from './helpers.js';

test('one merged inbox: every thread is tagged with its account and sorted newest first', async () => {
  const t = await setup();
  const { threads, errors } = await t.service.listThreads({ view: 'inbox' });
  assert.deepEqual(errors, []);
  assert.equal(threads.length, 11);
  const ids = new Set(Object.values(t.accounts).map((a) => a.id));
  assert.ok(threads.every((x) => ids.has(x.accountId)));
  for (const a of Object.values(t.accounts)) assert.ok(threads.some((x) => x.accountId === a.id), `no mail from ${a.email}`);
  for (let i = 1; i < threads.length; i++) assert.ok(threads[i - 1].internalDate >= threads[i].internalDate);
  const maria = threads.find((x) => x.subject.startsWith('Contract renewal'));
  assert.equal(maria.accountId, t.accounts[WORK].id);
  assert.equal(maria.unread, true);
  await t.close();
});

test('a revoked account is reported and the other accounts still load', async () => {
  const t = await setup();
  t.fake.state.forceInvalidGrant.add(PERSONAL);
  t.service.auth.tokens.clear();
  const { threads, errors } = await t.service.listThreads({ view: 'inbox' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].email, PERSONAL);
  assert.equal(errors[0].code, 'reauth_required');
  assert.equal(threads.length, 7);
  assert.ok(threads.every((x) => x.accountId !== t.accounts[PERSONAL].id));
  const flags = Object.fromEntries((await t.service.accounts()).map((a) => [a.email, a.needsReauth]));
  assert.deepEqual(flags, { [WORK]: false, [PERSONAL]: true, [STUDIO]: false });

  // Reconnecting clears the flag and mail flows again.
  t.fake.state.forceInvalidGrant.clear();
  await signIn(t.service, PERSONAL);
  const again = await t.service.listThreads({ view: 'inbox' });
  assert.equal(again.errors.length, 0);
  assert.equal(again.threads.length, 11);
  assert.equal((await t.service.accounts()).find((a) => a.email === PERSONAL).needsReauth, false);
  await t.close();
});

test('paging walks every account without duplicates', async () => {
  const t = await setup();
  const seen = new Set();
  let pageTokens;
  let pages = 0;
  do {
    const r = await t.service.listThreads({ view: 'inbox', perAccount: 2, pageTokens });
    for (const x of r.threads) {
      assert.ok(!seen.has(x.key), `duplicate ${x.key}`);
      seen.add(x.key);
    }
    pageTokens = Object.keys(r.nextTokens).length ? r.nextTokens : undefined;
    pages++;
  } while (pageTokens && pages < 10);
  assert.equal(seen.size, 11);
  assert.ok(pages > 1);
  await t.close();
});

test('search and views filter across accounts, and accounts can be limited', async () => {
  const t = await setup();
  const hit = await t.service.listThreads({ view: 'all', q: 'renewal' });
  assert.ok(hit.threads.length >= 1);
  assert.ok(hit.threads.some((x) => x.subject.includes('Contract renewal')));
  const unread = await t.service.listThreads({ view: 'unread' });
  assert.ok(unread.threads.length > 0 && unread.threads.every((x) => x.unread));
  const only = await t.service.listThreads({ view: 'inbox', accounts: ['personal'] });
  assert.equal(only.threads.length, 4);
  assert.ok(only.threads.every((x) => x.accountId === t.accounts[PERSONAL].id));
  await assert.rejects(() => t.service.listThreads({ view: 'bogus' }), ServiceError);
  await t.close();
});

test('accounts resolve by id, address, label and unambiguous fragment', async () => {
  const t = await setup();
  const id = t.accounts[WORK].id;
  for (const ref of [id, WORK, 'leo.work', 'LEO.WORK@ACME-EXAMPLE.COM']) assert.equal((await t.service.resolve(ref)).email, WORK);
  await t.service.updateAccount(id, { label: 'Day Job' });
  assert.equal((await t.service.resolve('day job')).email, WORK);
  await assert.rejects(() => t.service.resolve('nobody'), (e) => e.status === 404 && /Connected:/.test(e.message));
  await t.close();
});

test('marking read really changes the thread in Gmail', async () => {
  const t = await setup();
  const before = await t.service.listThreads({ view: 'unread', accounts: ['work'] });
  const maria = before.threads.find((x) => x.subject.startsWith('Contract'));
  await t.service.modifyThread('work', maria.threadId, 'read');
  const after = await t.service.listThreads({ view: 'unread', accounts: ['work'] });
  assert.ok(!after.threads.some((x) => x.threadId === maria.threadId));
  await t.service.modifyThread('work', maria.threadId, 'archive');
  const inbox = await t.service.listThreads({ view: 'inbox', accounts: ['work'] });
  assert.ok(!inbox.threads.some((x) => x.threadId === maria.threadId));
  await assert.rejects(() => t.service.modifyThread('work', maria.threadId, 'explode'), /Unknown action/);
  await t.close();
});

test('a reply goes out from the right account, threaded, with the original quoted', async () => {
  const t = await setup();
  const info = await t.service.getThread('work', 'wt1');
  await t.service.send({
    account: 'work', to: info.reply.single.to, subject: info.reply.single.subject, body: 'Yes to both.',
    threadId: 'wt1', replyToMessageId: info.reply.messageId,
  });
  const [mail] = t.sent(WORK);
  assert.equal(mail.headers.from, WORK);
  assert.match(mail.headers.to, /maria\.keller@client-example\.com/);
  assert.equal(mail.headers.subject, 'Re: Contract renewal, need your answer by Friday');
  assert.equal(mail.headers['in-reply-to'], '<w1@fake.example>');
  assert.match(mail.text, /^Yes to both\./);
  assert.match(mail.text, /> 1\. Are you fine with the 12 month term\?/);
  assert.equal(t.sent(PERSONAL).length, 0);
  assert.equal(t.sent(STUDIO).length, 0);
  const thread = await t.service.getThread('work', 'wt1');
  assert.equal(thread.thread.messages.length, 2);
  await t.close();
});

test('mixing up accounts fails instead of sending from the wrong one', async () => {
  const t = await setup();
  // thread pt1 and message p1 live in the Personal account, not in Work
  await assert.rejects(
    () => t.service.send({ account: 'work', to: 'sophie.martin@example.org', subject: 'Re: Dinner', body: 'x', threadId: 'pt1', replyToMessageId: 'p1' }),
    (e) => e instanceof GmailError && e.status === 404,
  );
  assert.equal(t.sent(WORK).length, 0);
  await t.close();
});

test('header injection through the subject or recipient is refused before anything is sent', async () => {
  const t = await setup();
  await assert.rejects(() => t.service.send({ account: 'work', to: 'a@y.io', subject: 'Hi\r\nBcc: evil@z.io', body: 'x' }), /line breaks/);
  await assert.rejects(() => t.service.send({ account: 'work', to: 'a@y.io, evil', subject: 's', body: 'x' }), /Invalid email/);
  assert.equal(t.sent(WORK).length, 0);
  await t.close();
});

test('draftReply addresses the other person, never the account itself', async () => {
  const t = await setup();
  const d = await t.service.draftReply('work', 'wt2', 'Keep mobile in Q4.', { replyAll: true });
  const [draft] = t.drafts(WORK);
  assert.equal(draft._raw.headers.to, 'Tom Becker <tom.becker@acme-example.com>');
  assert.equal(draft._raw.headers.cc, 'Nina Roth <nina.roth@acme-example.com>');
  assert.ok(!draft._raw.headers.to.includes(WORK));
  assert.equal(d.threadId, 'wt2');
  const sent = await t.service.sendDraft('work', d.draftId);
  assert.equal(sent.threadId, 'wt2');
  assert.equal(t.sent(WORK).length, 1);
  await t.close();
});

test('removing an account revokes the grant at Google and forgets it locally', async () => {
  const t = await setup();
  await t.service.removeAccount('studio');
  assert.deepEqual(t.fake.state.revoked, [`rt-${STUDIO}`]);
  assert.equal((await t.service.accounts()).length, 2);
  assert.equal((await t.store.list()).some((a) => a.email === STUDIO), false);
  await t.close();
});

test('expired access tokens refresh transparently on a 401', async () => {
  const t = await setup();
  await t.service.listThreads({ view: 'inbox', accounts: ['work'] });
  t.service.auth.tokens.get(t.accounts[WORK].id).token = 'stale-token';
  const r = await t.service.listThreads({ view: 'inbox', accounts: ['work'] });
  assert.equal(r.errors.length, 0);
  assert.equal(r.threads.length, 4);
  await t.close();
});

test('AuthError is what callers see when the grant is dead', async () => {
  const t = await setup();
  t.fake.state.forceInvalidGrant.add(WORK);
  t.service.auth.tokens.clear();
  await assert.rejects(() => t.service.getThread('work', 'wt1'), AuthError);
  await t.close();
});
