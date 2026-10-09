// Turning untrusted mail into prompt text. Everything a stranger wrote goes inside tags,
// and anything that could close or fake those tags is defanged first.

export const defang = (s) => String(s).replace(/<(\/?)(email|message|untrusted_email_content)/gi, '<\\$1$2');
export const attr = (s) => String(s ?? '').replace(/["<>\r\n]/g, ' ').trim();
const fmtAddr = (a) => (a.name ? `${attr(a.name)} <${attr(a.email)}>` : attr(a.email));

export const untrusted = (s) => `<untrusted_email_content>\n${defang(s)}\n</untrusted_email_content>`;

/** Renders a thread. When the budget runs out the newest messages win and older ones are reported as omitted. */
export function renderThread(account, thread, { maxChars = 14000, perMessage = 6000 } = {}) {
  const parts = [];
  let used = 0;
  let omitted = 0;
  const msgs = thread.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    let body = m.text || m.snippet;
    if (body.length > perMessage) body = `${body.slice(0, perMessage)}\n[... ${body.length - perMessage} more characters of this message not shown]`;
    const block =
      `<message from="${fmtAddr(m.from)}" to="${attr(m.to.map(fmtAddr).join(', '))}"` +
      `${m.cc.length ? ` cc="${attr(m.cc.map(fmtAddr).join(', '))}"` : ''} date="${attr(m.date)}"` +
      `${m.sent ? ' sent_by_account_owner="true"' : ''}` +
      `${m.attachments.length ? ` attachments="${attr(m.attachments.map((a) => a.filename).join(', '))}"` : ''}>\n${defang(body)}\n</message>`;
    if (used + block.length > maxChars && parts.length) {
      omitted = i + 1;
      break;
    }
    parts.unshift(block);
    used += block.length;
  }
  const head = `<email account="${attr(account.label)} <${attr(account.email)}>" thread_id="${attr(thread.id)}" subject="${attr(msgs[0]?.subject)}">`;
  const note = omitted ? `\n[${omitted} earlier message(s) in this thread are not shown]` : '';
  return `${head}${note}\n${parts.join('\n')}\n</email>`;
}
