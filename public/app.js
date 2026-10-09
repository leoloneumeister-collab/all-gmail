// All Gmail front end. Plain ES modules, no build step.
// Rule: mail content only ever reaches the DOM through textContent (via el()) or the sandboxed iframe.

const $ = (sel, root = document) => root.querySelector(sel);
const enc = encodeURIComponent;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

// Like node.replaceChildren(), but skips null/false (the native one would print the word "null").
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const VIEWS = [
  { id: 'inbox', label: 'Inbox' }, { id: 'unread', label: 'Unread' }, { id: 'starred', label: 'Starred' },
  { id: 'sent', label: 'Sent' }, { id: 'drafts', label: 'Drafts' }, { id: 'all', label: 'All mail' },
  { id: 'spam', label: 'Spam' }, { id: 'trash', label: 'Trash' },
];
const CATEGORY = { needs_reply: 'needs reply', action: 'action', fyi: 'FYI', newsletter: 'newsletter', receipt: 'receipt', notification: 'notification', suspicious: 'suspicious' };

const state = {
  accounts: [], googleConfigured: true, claude: { hasKey: false, model: '' },
  view: 'inbox', q: '', hidden: new Set(store.get('hidden', [])),
  threads: [], nextTokens: {}, errors: [], loading: false, reqId: 0,
  triage: new Map(), aiSort: false, triageBusy: false,
  sel: null, open: null, summary: null,
  chat: [], chatBusy: false,
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-all-gmail': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || res.statusText);
    err.code = data.error?.code;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 6000 : 2600);
}

const acct = (id) => state.accounts.find((a) => a.id === id);
const visibleIds = () => state.accounts.filter((a) => !state.hidden.has(a.id)).map((a) => a.id);

function chip(a, text) {
  const c = el('span', { class: 'chip', title: a?.email ?? '' }, text ?? a?.label ?? '?');
  c.style.setProperty('--c', a?.color ?? '#888');
  return c;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
const fmtFull = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.replaceChildren(el('span', { class: 'spinner' }), ` ${label}`);
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

// ---------------- sidebar ----------------

function renderSidebar() {
  const s = $('#sidebar');
  s.replaceChildren(
    el('div', { class: 'brand' }, el('img', { src: '/favicon.svg', alt: '' }), 'All Gmail'),
    el('button', { class: 'btn primary compose', type: 'button', onclick: () => openCompose() }, 'Compose'),
    el('div', { class: 'section-title' }, 'Accounts', el('a', { class: 'btn small ghost', href: '/auth/start', title: 'Connect another Gmail account' }, '+ Add')),
    ...state.accounts.map(accountRow),
    el('div', { class: 'section-title' }, 'Folders'),
    ...VIEWS.map((v) => el('button', { class: 'nav-item', type: 'button', 'aria-current': String(state.view === v.id), onclick: () => { document.body.classList.remove('menu'); setView(v.id); } }, v.label)),
    el('div', { class: 'sidebar-foot' },
      state.claude.hasKey ? `Claude: ${state.claude.model}` : el('span', {}, 'No ', el('code', {}, 'ANTHROPIC_API_KEY'), ' in .env yet. Claude features need one.')),
  );
}

function accountRow(a) {
  const off = state.hidden.has(a.id);
  const row = el('div', { class: `acct${off ? ' off' : ''}` },
    el('button', { class: 'acct-main', type: 'button', title: off ? 'Show this account' : 'Hide this account from the list', 'aria-pressed': String(!off), onclick: () => toggleAccount(a.id) },
      el('span', { class: 'dot' }),
      el('span', { class: 'acct-text' }, el('span', { class: 'acct-name' }, a.label), el('span', { class: 'acct-mail' }, a.email)),
      a.needsReauth ? el('span', { class: 'badge-warn' }, 'reconnect') : null),
    el('button', { class: 'gear', type: 'button', 'aria-label': `Settings for ${a.label}`, onclick: () => openAccountSettings(a) }, '⚙'),
  );
  row.style.setProperty('--c', a.color);
  return row;
}

function toggleAccount(id) {
  if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
  store.set('hidden', [...state.hidden]);
  renderSidebar();
  loadThreads();
}

function setView(v) {
  state.view = v;
  state.triage = new Map();
  state.aiSort = false;
  closeThread();
  renderSidebar();
  loadThreads();
}

// ---------------- list ----------------

function buildListPane() {
  const input = el('input', { type: 'search', placeholder: 'Search all accounts (Gmail syntax works)', 'aria-label': 'Search', id: 'search' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.q = input.value.trim(); state.triage = new Map(); state.aiSort = false; loadThreads(); } });
  $('#list-pane').replaceChildren(
    el('div', { class: 'list-head' },
      el('button', { class: 'btn small menu-btn', type: 'button', onclick: () => document.body.classList.toggle('menu') }, '☰'),
      input,
      el('button', { class: 'btn small', type: 'button', title: 'Refresh', onclick: () => loadThreads() }, '↻'),
      el('button', { class: 'btn small', type: 'button', id: 'triage-btn', onclick: runTriage }, 'Sort with Claude'),
    ),
    el('div', { id: 'banners' }),
    el('div', { class: 'threads', id: 'threads', role: 'list' }),
  );
}

async function loadThreads(append = false) {
  const my = ++state.reqId;
  state.loading = true;
  renderList();
  const ids = visibleIds();
  try {
    if (!ids.length) {
      Object.assign(state, { threads: [], nextTokens: {}, errors: [] });
    } else {
      const p = new URLSearchParams({ view: state.view, q: state.q });
      if (ids.length !== state.accounts.length) p.set('accounts', ids.join(','));
      if (append) p.set('tokens', JSON.stringify(state.nextTokens));
      const r = await api(`/api/threads?${p}`);
      if (my !== state.reqId) return;
      const merged = append ? [...state.threads, ...r.threads] : r.threads;
      state.threads = merged.sort((a, b) => b.internalDate - a.internalDate);
      state.nextTokens = r.nextTokens;
      state.errors = r.errors;
      if (r.errors.some((e) => e.code === 'reauth_required')) refreshAccounts();
    }
  } catch (e) {
    if (my === state.reqId) toast(e.message, true);
  } finally {
    if (my === state.reqId) { state.loading = false; renderList(); }
  }
}

async function refreshAccounts() {
  const s = await api('/api/state');
  state.accounts = s.accounts;
  renderSidebar();
}

function sortedThreads() {
  if (!state.aiSort) return state.threads;
  const rank = { high: 0, normal: 1, low: 2 };
  return [...state.threads].sort((a, b) => (rank[state.triage.get(a.key)?.priority] ?? 3) - (rank[state.triage.get(b.key)?.priority] ?? 3) || b.internalDate - a.internalDate);
}

function renderList() {
  const banners = $('#banners');
  const list = $('#threads');
  if (!list) return;
  banners.replaceChildren(
    ...state.errors.map((e) => el('div', { class: 'banner' },
      el('span', {}, `${acct(e.accountId)?.label ?? e.email}: ${e.message}`),
      e.code === 'reauth_required' ? el('a', { class: 'btn small', href: `/auth/start?hint=${enc(e.email)}` }, 'Reconnect') : null)),
  );
  const tb = $('#triage-btn');
  if (tb) {
    tb.textContent = state.aiSort ? 'Clear AI sort' : 'Sort with Claude';
    tb.disabled = state.triageBusy;
  }
  if (!state.accounts.length) { list.replaceChildren(emptyState()); return; }
  if (state.loading && !state.threads.length) { list.replaceChildren(el('div', { class: 'empty' }, el('span', { class: 'spinner' }), ' Loading mail from all accounts')); return; }
  const rows = sortedThreads().map(rowEl);
  if (!rows.length) rows.push(el('div', { class: 'empty' }, visibleIds().length ? 'Nothing here.' : 'All accounts are hidden. Click an account on the left to show it.'));
  if (Object.keys(state.nextTokens).length) {
    rows.push(el('button', { class: 'btn load-more', type: 'button', disabled: state.loading, onclick: () => loadThreads(true) }, state.loading ? 'Loading' : 'Load more'));
  }
  list.replaceChildren(...rows);
}

function emptyState() {
  return el('div', { class: 'empty' },
    el('h2', {}, 'Connect your Gmail accounts'),
    state.googleConfigured
      ? el('p', {}, 'Add as many accounts as you like. Mail from all of them shows up here, with a colored label so you always know where it came from.')
      : el('div', {},
          el('p', {}, 'One-time setup first: create a Google OAuth client (about 5 minutes).'),
          el('ol', {}, el('li', {}, 'Follow the README, section "1. Google setup"'), el('li', {}, 'Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env'), el('li', {}, 'Restart the app'))),
    el('a', { class: 'btn primary', href: '/auth/start' }, 'Connect a Gmail account'));
}

function rowEl(t) {
  const a = acct(t.accountId);
  const tri = state.triage.get(t.key);
  const selected = state.sel && state.sel.accountId === t.accountId && state.sel.threadId === t.threadId;
  const people = t.participants.length > 1 ? t.participants.slice(0, 3).join(', ') + (t.messageCount > 1 ? ` (${t.messageCount})` : '') : (t.from.name || t.from.email || '');
  const b = el('button', {
    class: `row${t.unread ? ' unread' : ''}`, type: 'button', role: 'listitem', 'aria-current': String(Boolean(selected)),
    onclick: () => openThread(t.accountId, t.threadId),
  },
    el('span', { class: 'bar' }),
    el('span', { class: 'body' },
      el('span', { class: 'top' }, chip(a), el('span', { class: 'from' }, people), t.starred ? el('span', { title: 'Starred' }, '★') : null, el('span', { class: 'time' }, fmtTime(t.date))),
      el('div', { class: 'subject' }, t.subject),
      el('div', { class: 'snippet' }, t.snippet),
      tri ? el('div', { class: 'meta' }, el('span', { class: `tag ${tri.priority}` }, tri.priority), tri.category !== 'fyi' ? el('span', { class: `tag ${tri.category}` }, CATEGORY[tri.category] ?? tri.category) : null, el('span', { class: 'tag reason' }, tri.reason)) : null,
    ),
  );
  b.style.setProperty('--c', a?.color ?? '#888');
  return b;
}

async function runTriage() {
  if (state.aiSort) { state.aiSort = false; renderList(); return; }
  if (!state.threads.length) return;
  state.triageBusy = true;
  const btn = $('#triage-btn');
  btn.disabled = true;
  btn.replaceChildren(el('span', { class: 'spinner' }), ' Thinking');
  try {
    const ids = visibleIds();
    const r = await api('/api/claude/triage', { method: 'POST', body: { view: state.view, q: state.q, accounts: ids.length !== state.accounts.length ? ids : undefined } });
    state.triage = new Map(r.items.map((i) => [i.key, i]));
    state.aiSort = true;
    toast(`Claude ranked ${r.items.length} threads`);
  } catch (e) { toast(e.message, true); }
  finally { state.triageBusy = false; renderList(); }
}

// ---------------- reading pane ----------------

function closeThread() {
  state.sel = null; state.open = null; state.summary = null; state.openReply = null;
  document.body.classList.remove('reading');
  $('#read-pane').replaceChildren(el('div', { class: 'read-empty' }, 'Select a conversation'));
  renderList();
}

async function openThread(accountId, threadId) {
  state.sel = { accountId, threadId };
  state.summary = null;
  document.body.classList.add('reading');
  renderList();
  $('#read-pane').replaceChildren(el('div', { class: 'read-empty' }, el('span', { class: 'spinner' }), ' Loading'));
  try {
    const data = await api(`/api/threads/${enc(accountId)}/${enc(threadId)}`);
    if (!state.sel || state.sel.threadId !== threadId) return;
    state.open = data;
    renderThread();
    const row = state.threads.find((t) => t.accountId === accountId && t.threadId === threadId);
    if (row?.unread) {
      api(`/api/threads/${enc(accountId)}/${enc(threadId)}/read`, { method: 'POST' }).then(() => { row.unread = false; renderList(); }).catch(() => {});
    }
  } catch (e) {
    $('#read-pane').replaceChildren(el('div', { class: 'read-empty' }, e.message, ' ', e.code === 'reauth_required' ? el('a', { href: `/auth/start?hint=${enc(acct(accountId)?.email ?? '')}` }, 'Reconnect') : null));
  }
}

function renderThread() {
  const { account, thread, reply } = state.open;
  const a = acct(account.id) ?? account;
  const row = state.threads.find((t) => t.accountId === account.id && t.threadId === thread.id);
  const first = thread.messages[0];
  const gmailUrl = `https://mail.google.com/mail/?authuser=${enc(a.email)}#all/${enc(thread.id)}`;
  const replyBox = el('div', {});
  const summaryBox = el('div', {});
  const paintSummary = () => summaryBox.replaceChildren(...(state.summary ? [summaryCard(state.summary)] : []));

  const sumBtn = el('button', { class: 'btn small', type: 'button', onclick: () => busy(sumBtn, 'Summarizing', async () => {
    try { state.summary = (await api('/api/claude/summarize', { method: 'POST', body: { account: a.id, threadId: thread.id } })).summary; paintSummary(); }
    catch (e) { toast(e.message, true); }
  }) }, 'Summarize with Claude');

  const head = el('div', { class: 'read-head' },
    el('div', { class: 'line' },
      el('button', { class: 'btn small back-btn', type: 'button', onclick: closeThread }, '← Back'),
      chip(a), el('span', { class: 'acct-mail' }, `in ${a.email}`), el('span', { class: 'grow' }),
      el('a', { class: 'btn small ghost', href: gmailUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Gmail ↗')),
    el('h1', {}, first?.subject ?? '(no subject)'),
    el('div', { class: 'line' },
      el('button', { class: 'btn small', type: 'button', onclick: () => act('archive') }, 'Archive'),
      el('button', { class: 'btn small', type: 'button', onclick: () => act(row?.starred ? 'unstar' : 'star') }, row?.starred ? '★ Unstar' : '☆ Star'),
      el('button', { class: 'btn small', type: 'button', onclick: () => act('unread') }, 'Mark unread'),
      el('button', { class: 'btn small danger', type: 'button', onclick: () => act('trash') }, 'Trash'),
      el('span', { class: 'grow' }), sumBtn),
  );

  const msgs = thread.messages.map((m, i) => messageEl(a, m, i === thread.messages.length - 1));
  const replyButtons = el('div', { class: 'actions' },
    el('button', { class: 'btn primary', type: 'button', onclick: () => showReply(replyBox, a, reply, false) }, 'Reply'),
    reply && reply.all.cc.length ? el('button', { class: 'btn', type: 'button', onclick: () => showReply(replyBox, a, reply, true) }, 'Reply all') : null);
  replyBox.replaceChildren(replyButtons);
  state.openReply = () => showReply(replyBox, a, reply, false);
  paintSummary();
  $('#read-pane').replaceChildren(head, el('div', { class: 'read-scroll' }, summaryBox, ...msgs, replyBox));
  msgs[msgs.length - 1]?.scrollIntoView({ block: 'start' });
}

function summaryCard(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, ''));
  const rest = lines.filter((l) => !/^[-*•]\s+/.test(l));
  return el('div', { class: 'ai-card' }, el('h3', {}, 'Claude summary'), ...rest.map((l) => el('p', {}, l)), bullets.length ? el('ul', {}, bullets.map((b) => el('li', {}, b))) : null);
}

function messageEl(a, m, expanded) {
  const who = m.sent ? 'me' : m.from.name || m.from.email;
  const body = el('div', { class: 'msg-body' });
  const paint = () => {
    fill(body,
      el('div', { class: 'msg-to' }, `from ${m.from.email} · to ${m.to.map((x) => x.name || x.email).join(', ') || 'undisclosed'}${m.cc.length ? ` · cc ${m.cc.map((x) => x.name || x.email).join(', ')}` : ''}`),
      m.hasHtml ? htmlFrame(a, m) : el('div', { class: 'msg-text' }, m.text || '(empty message)'),
      m.attachments.length ? el('div', { class: 'attachments' }, m.attachments.filter((x) => x.attachmentId).map((x) => el('a', { href: `/api/attachment/${enc(a.id)}/${enc(m.id)}/${enc(x.attachmentId)}?filename=${enc(x.filename)}` }, `📎 ${x.filename}`))) : null,
    );
  };
  const head = el('button', { class: 'msg-head', type: 'button', 'aria-expanded': String(expanded) });
  const wrap = el('div', { class: 'msg' }, head, body);
  const setOpen = (open) => {
    head.setAttribute('aria-expanded', String(open));
    fill(head, el('span', { class: 'who' }, who), open ? null : el('span', { class: 'preview' }, m.snippet), el('span', { class: 'when' }, fmtFull(m.date)));
    if (open) paint(); else body.replaceChildren();
  };
  head.addEventListener('click', () => setOpen(head.getAttribute('aria-expanded') !== 'true'));
  setOpen(expanded);
  return wrap;
}

function htmlFrame(a, m) {
  let images = false;
  const f = el('iframe', { sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer', title: 'Email content' });
  const load = () => f.setAttribute('src', `/api/body/${enc(a.id)}/${enc(m.id)}?images=${images ? 1 : 0}`);
  f.addEventListener('load', () => {
    try { f.style.height = `${Math.min(f.contentDocument.documentElement.scrollHeight + 4, 5000)}px`; } catch {}
  });
  const bar = el('div', { class: 'img-bar' }, 'Remote images are blocked.');
  const btn = el('button', { class: 'btn small', type: 'button', onclick: () => { images = true; bar.remove(); load(); } }, 'Load images');
  bar.append(btn);
  load();
  return el('div', {}, bar, f);
}

async function act(action) {
  const { accountId, threadId } = state.sel;
  try {
    await api(`/api/threads/${enc(accountId)}/${enc(threadId)}/${action}`, { method: 'POST' });
  } catch (e) { toast(e.message, true); return; }
  const row = state.threads.find((t) => t.accountId === accountId && t.threadId === threadId);
  if (action === 'star' || action === 'unstar') { if (row) row.starred = action === 'star'; renderList(); renderThread(); return; }
  if (action === 'unread' && row) row.unread = true;
  const leavesView = action === 'trash' || (action === 'archive' && ['inbox', 'unread'].includes(state.view));
  if (leavesView) state.threads = state.threads.filter((t) => !(t.accountId === accountId && t.threadId === threadId));
  toast({ archive: 'Archived', trash: 'Moved to trash', unread: 'Marked unread' }[action] ?? 'Done');
  closeThread();
}

// ---------------- reply ----------------

function showReply(box, a, reply, all) {
  const d = all ? reply.all : reply.single;
  const to = el('input', { type: 'text', id: 'r-to', value: d.to.join(', ') });
  const cc = el('input', { type: 'text', id: 'r-cc', value: d.cc.join(', ') });
  const subject = el('input', { type: 'text', id: 'r-subject', value: d.subject });
  const body = el('textarea', { id: 'r-body', placeholder: 'Write your reply, or let Claude draft it below', 'aria-label': 'Reply text' });
  const instr = el('input', { type: 'text', placeholder: 'Tell Claude what to say, e.g. "yes to 12 months, push the rate to 100"', 'aria-label': 'Instruction for Claude' });
  const notes = el('ul', { class: 'notes' });
  let claudeDrafted = false;

  const draftBtn = el('button', { class: 'btn', type: 'button', onclick: () => busy(draftBtn, 'Drafting', async () => {
    try {
      const r = await api('/api/claude/draft', { method: 'POST', body: { account: a.id, threadId: state.sel.threadId, instruction: instr.value, replyAll: all } });
      body.value = r.body; claudeDrafted = true;
      notes.replaceChildren(...r.notes.map((n) => el('li', {}, n)));
      body.focus();
    } catch (e) { toast(e.message, true); }
  }) }, 'Draft with Claude');

  const payload = () => ({ account: a.id, to: to.value, cc: cc.value || undefined, subject: subject.value, body: body.value, threadId: state.sel.threadId, replyToMessageId: state.open.reply.messageId, includeQuote: true });

  const sendBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => {
    if (!body.value.trim()) { toast('Write something first', true); return; }
    if (claudeDrafted && /\[[^\]\n]{3,}\]/.test(body.value) && !confirm('This draft still contains [bracketed placeholders]. Send anyway?')) return;
    busy(sendBtn, 'Sending', async () => {
      try {
        await api('/api/send', { method: 'POST', body: payload() });
        toast(`Sent from ${a.label}`);
        openThread(a.id, state.sel.threadId);
      } catch (e) { toast(e.message, true); }
    });
  } }, 'Send');
  const saveBtn = el('button', { class: 'btn', type: 'button', onclick: () => busy(saveBtn, 'Saving', async () => {
    try { await api('/api/drafts', { method: 'POST', body: payload() }); toast(`Draft saved in ${a.label}`); } catch (e) { toast(e.message, true); }
  }) }, 'Save draft');

  box.replaceChildren(el('div', { class: 'reply' },
    el('div', { class: 'from-line' }, el('span', {}, 'Sending from'), chip(a), el('strong', {}, a.email), all ? el('span', { class: 'tag' }, 'reply all') : null),
    el('div', { class: 'field' }, el('label', { for: 'r-to' }, 'To'), to),
    el('div', { class: 'field' }, el('label', { for: 'r-cc' }, 'Cc'), cc),
    el('div', { class: 'field' }, el('label', { for: 'r-subject' }, 'Subject'), subject),
    el('div', { class: 'claude-row' }, instr, draftBtn),
    notes, body,
    el('div', { class: 'actions' }, sendBtn, saveBtn, el('span', { class: 'grow' }), el('button', { class: 'btn ghost', type: 'button', onclick: () => renderThread() }, 'Discard')),
  ));
  (state.claude.hasKey ? instr : body).focus();
}

// ---------------- dialogs ----------------

function openDialog(...children) {
  const dlg = $('#dialog');
  dlg.replaceChildren(el('div', { class: 'dlg' }, ...children));
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  dlg.showModal();
  return dlg;
}

function openAccountSettings(a) {
  const label = el('input', { type: 'text', id: 'a-label', value: a.label, maxlength: '40' });
  const color = el('input', { type: 'color', id: 'a-color', value: a.color });
  const persona = el('textarea', { id: 'a-persona', placeholder: 'e.g. Work account. Polite and brief. Sign as "Leo". Reply in German to German mails.' });
  persona.value = a.persona ?? '';
  const dlg = openDialog(
    el('h2', {}, `${a.label} settings`),
    el('div', {}, el('label', { for: 'a-label' }, 'Name shown on every mail from this account'), label),
    el('div', {}, el('label', { for: 'a-color' }, 'Color'), color),
    el('div', {}, el('label', { for: 'a-persona' }, 'How Claude should write from this account'), persona,
      el('p', { class: 'help' }, 'Claude reads this whenever it drafts a reply from this account, so work and personal mail can sound different.')),
    el('p', { class: 'help' }, a.email),
    el('div', { class: 'actions' },
      el('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Disconnect ${a.email}? Its mail stays in Gmail, it just disappears from here.`)) return;
        try { await api(`/api/accounts/${enc(a.id)}`, { method: 'DELETE' }); dlg.close(); await refreshAccounts(); await loadThreads(); toast('Disconnected'); } catch (e) { toast(e.message, true); }
      } }, 'Disconnect'),
      a.needsReauth ? el('a', { class: 'btn', href: `/auth/start?hint=${enc(a.email)}` }, 'Reconnect') : null,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { await api(`/api/accounts/${enc(a.id)}`, { method: 'PATCH', body: { label: label.value, color: color.value, persona: persona.value } }); dlg.close(); await refreshAccounts(); renderList(); if (state.open) renderThread(); } catch (e) { toast(e.message, true); }
      } }, 'Save')),
  );
}

function openCompose() {
  if (!state.accounts.length) { location.href = '/auth/start'; return; }
  const from = el('select', { id: 'c-from' }, state.accounts.map((a) => el('option', { value: a.id }, `${a.label}  <${a.email}>`)));
  const preferred = state.sel?.accountId ?? visibleIds()[0];
  if (preferred) from.value = preferred;
  const to = el('input', { type: 'text', id: 'c-to', placeholder: 'name@example.com' });
  const subject = el('input', { type: 'text', id: 'c-subject' });
  const body = el('textarea', { id: 'c-body' });
  const dlg = openDialog(
    el('h2', {}, 'New message'),
    el('div', {}, el('label', { for: 'c-from' }, 'From (pick the account carefully)'), from),
    el('div', {}, el('label', { for: 'c-to' }, 'To'), to),
    el('div', {}, el('label', { for: 'c-subject' }, 'Subject'), subject),
    el('div', {}, el('label', { for: 'c-body' }, 'Message'), body),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await api('/api/drafts', { method: 'POST', body: { account: from.value, to: to.value, subject: subject.value, body: body.value } }); dlg.close(); toast('Draft saved'); } catch (e) { toast(e.message, true); }
      } }, 'Save draft'),
      el('button', { class: 'btn primary', type: 'button', onclick: async () => {
        if (!body.value.trim()) { toast('Write something first', true); return; }
        try { await api('/api/send', { method: 'POST', body: { account: from.value, to: to.value, subject: subject.value, body: body.value } }); dlg.close(); toast(`Sent from ${acct(from.value).label}`); } catch (e) { toast(e.message, true); }
      } }, 'Send')),
  );
  to.focus();
}

// ---------------- chat ----------------

const HINTS = ['What needs a reply today?', 'Summarize my unread mail from all accounts', 'Anything from Maria? Draft an answer'];
const STEP_TEXT = {
  list_accounts: () => 'Checked connected accounts',
  search_mail: (i) => `Searched mail${i.query ? `: ${i.query}` : ''}`,
  read_thread: () => 'Read a conversation',
  draft_reply: () => 'Wrote a draft reply',
};

function renderChat() {
  const c = $('#chat');
  const log = el('div', { class: 'chat-log', id: 'chat-log' });
  for (const m of state.chat) {
    if (m.role === 'step') log.append(el('div', { class: 'step' }, m.text));
    else if (m.role === 'draft') log.append(el('div', { class: 'draft-card' }, chip(acct(m.accountId)), 'Draft saved. Review and send it from Gmail:', el('a', { href: `https://mail.google.com/mail/?authuser=${enc(acct(m.accountId)?.email ?? '')}#drafts`, target: '_blank', rel: 'noopener noreferrer' }, 'Open drafts ↗')));
    else log.append(el('div', { class: `bubble ${m.role}${m.error ? ' error' : ''}` }, m.content));
  }
  if (state.chatBusy) log.append(el('div', { class: 'step' }, el('span', { class: 'spinner' }), ' Claude is working'));
  const input = el('textarea', { rows: '1', placeholder: 'Ask about your mail across all accounts', 'aria-label': 'Message for Claude' });
  const sendIt = () => { const t = input.value.trim(); if (t && !state.chatBusy) sendChat(t); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
  fill(c,
    el('div', { class: 'chat-head' }, el('h2', {}, 'Ask Claude'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => { state.chat = []; renderChat(); } }, 'Clear'),
      el('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Close', onclick: toggleChat }, '✕')),
    log,
    state.chat.length ? null : el('div', { class: 'chat-hints' }, HINTS.map((h) => el('button', { class: 'btn small', type: 'button', onclick: () => sendChat(h) }, h))),
    el('div', { class: 'chat-input' }, input, el('button', { class: 'btn primary', type: 'button', disabled: state.chatBusy, onclick: sendIt }, 'Send')),
  );
  log.scrollTop = log.scrollHeight;
  if (!c.hidden) input.focus();
}

function toggleChat() {
  const c = $('#chat');
  c.hidden = !c.hidden;
  $('#chat-toggle').hidden = !c.hidden;
  if (!c.hidden) renderChat();
}

async function sendChat(text) {
  state.chat.push({ role: 'user', content: text });
  state.chatBusy = true;
  renderChat();
  const history = state.chat.filter((m) => m.role === 'user' || m.role === 'assistant').map(({ role, content }) => ({ role, content }));
  try {
    const r = await api('/api/claude/chat', { method: 'POST', body: { messages: history, context: state.sel ? state.sel : undefined } });
    for (const s of r.steps) state.chat.push({ role: 'step', text: (STEP_TEXT[s.tool] ?? (() => s.tool))(s.input) });
    for (const d of r.drafts) state.chat.push({ role: 'draft', accountId: d.accountId });
    state.chat.push({ role: 'assistant', content: r.reply });
  } catch (e) {
    state.chat.push({ role: 'assistant', content: e.message, error: true });
  } finally {
    state.chatBusy = false;
    renderChat();
  }
}

// ---------------- keyboard ----------------

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
  if (e.key === 'Escape') {
    if (!$('#chat').hidden) toggleChat();
    else if (state.sel) closeThread();
    return;
  }
  if (typing || $('#dialog').open) return;
  const list = sortedThreads();
  const idx = list.findIndex((x) => state.sel && x.accountId === state.sel.accountId && x.threadId === state.sel.threadId);
  if (e.key === 'j' && list.length) { const n = list[Math.min(idx + 1, list.length - 1)]; openThread(n.accountId, n.threadId); }
  else if (e.key === 'k' && list.length && idx > 0) { const n = list[idx - 1]; openThread(n.accountId, n.threadId); }
  else if (e.key === 'e' && state.sel) act('archive');
  else if (e.key === 'r' && state.openReply) { e.preventDefault(); state.openReply(); }
  else if (e.key === 'c') { e.preventDefault(); openCompose(); }
  else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
});

// ---------------- boot ----------------

async function boot() {
  buildListPane();
  $('#chat-toggle').addEventListener('click', toggleChat);
  const params = new URLSearchParams(location.search);
  if (params.get('connected')) toast(`Connected ${params.get('connected')}`);
  if (params.get('error')) toast(params.get('error'), true);
  if (params.size) history.replaceState(null, '', '/');
  try {
    Object.assign(state, await api('/api/state'));
  } catch (e) {
    $('#list-pane').replaceChildren(el('div', { class: 'empty' }, `Cannot reach the local server: ${e.message}`));
    return;
  }
  renderSidebar();
  closeThread();
  if (state.accounts.length) await loadThreads(); else renderList();
}
boot();
