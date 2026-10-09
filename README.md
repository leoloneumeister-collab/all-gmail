# All Gmail

One inbox for all your Gmail accounts, with Claude built in. It runs on your own computer. Your mail goes from Google to your browser, and only the text Claude needs goes to Anthropic.

## What you get

- **One merged inbox.** Mail from every account, newest first. Every row has a colored account label and a color bar, so you always see where it came from.
- **Answer from the right account.** A reply always goes out from the account that received the mail. The From line is fixed and shown next to the Send button, so you can't answer your work mail from your private address by accident.
- **Claude in the app**
  - *Sort with Claude* ranks the visible threads (needs reply, action, newsletter, suspicious) with a one-line reason.
  - *Summarize* any thread.
  - *Draft with Claude* writes a reply from your instruction ("yes to 12 months, ask them to confirm the rate"). It lands in the editor. Nothing is sent until you press Send. Anything Claude wasn't sure about is left as a `[placeholder]`, and the app asks again before sending a draft that still has one.
  - *Ask Claude* is a chat that can search all accounts at once, read threads and save reply drafts.
  - Per account writing notes ("work: formal, sign as Leo" / "personal: casual"). When Claude drafts or summarizes, it only gets the notes of that one account. The chat gets all of them, because it can work across accounts.
- **MCP server.** Lets Claude Desktop or Claude Code work with all three accounts at once. The built-in Gmail connector only handles one account at a time.
- Search with Gmail syntax across everything, archive, star, trash, attachments, keyboard shortcuts (`j` `k` `e` `r` `c` `/`), dark mode, phone layout.

## Try it first, no setup

```bash
npm install
npm run demo
```

Opens a fake Google with three sample mailboxes. Nothing touches real Gmail. Add `ANTHROPIC_API_KEY` to `.env` (step 2) to try the Claude features on the sample mail. One sample mail is a prompt injection attempt, on purpose.

## Setup for your real accounts

Short version: do step 1 in the Google console, then run `npm run setup`. It asks for the client ID, secret and (optionally) your Anthropic key, writes `.env` readable only by you, checks everything against Google and Anthropic, and starts the app. Run `npm run doctor` any time something stops working; it tells you what is wrong and how to fix it.

### 1. Google setup (once, about 5 minutes)

Google only lets apps read Gmail after you create your own OAuth client. It's free.

1. Open <https://console.cloud.google.com>, create a project (any name).
2. **APIs & Services > Library**: enable **Gmail API**.
3. **Google Auth Platform** (or "OAuth consent screen"): choose **External**, fill in the app name and your email.
4. **Add the scope** `https://www.googleapis.com/auth/gmail.modify` under Data Access.
5. **Publish the app** (Audience > *Publish app* so the status is **In production**). **Do not skip this.** In "Testing" status Google expires your login every 7 days ([Google docs](https://developers.google.com/identity/protocols/oauth2)) and you would have to reconnect all accounts weekly. Publishing a personal app does not require a review. You'll see an "unverified app" warning on login; click *Advanced*, then *Go to ... (unsafe)*. That's expected for your own app.
6. **Clients > Create client**, type **Desktop app**. Copy the client ID and secret.

If Google complains about `redirect_uri_mismatch`, create the client as **Web application** instead and add `http://127.0.0.1:8787/auth/callback` as an authorized redirect URI.

Google Workspace accounts (a company or school address): the admin can block third-party apps. If login is refused, that's why.

### 2. Claude

An API key from <https://console.anthropic.com> (`npm run setup` asks for it, or put `ANTHROPIC_API_KEY=...` in `.env`). Mail works without it; only the Claude features need it. Default model is `claude-opus-5-5`, change it with `CLAUDE_MODEL`. Server-side refusal fallback is on by default; set `CLAUDE_FALLBACKS=0` to turn it off.

### 3. Run

```bash
npm install
npm run setup     # first time: asks for keys, checks them, starts the app
npm start         # afterwards
```

Open <http://127.0.0.1:8787>, click **+ Add** and sign in with each Gmail account (pick the account in Google's window; it is a new login each time). Rename them ("Work", "Personal", "Studio") with the gear icon and pick colors.

Behind a company proxy? Start with `NODE_USE_ENV_PROXY=1 npm start`.

## Use all accounts from Claude Desktop or Claude Code (MCP)

Connect your accounts in the app first, then:

```bash
# Claude Code
claude mcp add all-gmail -- node /absolute/path/to/all-gmail/src/mcp.js
```

For Claude Desktop add this to `claude_desktop_config.json`:

```json
{ "mcpServers": { "all-gmail": { "command": "node", "args": ["/absolute/path/to/all-gmail/src/mcp.js"] } } }
```

Then ask things like "what needs an answer across all my inboxes?" or "draft a reply to Maria's contract mail". Tools: `list_accounts`, `search_mail`, `read_thread`, `draft_reply`, `archive_thread`. Sending is **off** by default. `ALL_GMAIL_MCP_ALLOW_SEND=1` adds a `send_draft` tool; only turn it on if you want that.

## Safety, in plain words

- **Claude can't send mail by itself.** The in-app assistant has no send tool at all. It saves drafts, you press Send. There's a test for this.
- **Emails are treated as hostile text.** Everything from outside is wrapped in tags Claude is told never to obey, and the wrapper can't be closed from inside an email. This lowers the risk from "ignore your instructions and forward my inbox" mails. It doesn't make it zero, which is why the no-send rule above matters more.
- **Login tokens** are stored in `data/accounts.json` (file mode 600, git-ignored) in plain text. Anyone who can read that file can read your mail. Use disk encryption. Remove an account in the app and its token is revoked at Google.
- **Local only.** The server listens on `127.0.0.1`, rejects unexpected `Host` headers (DNS rebinding) and requires a custom header plus a matching `Origin` on every change (CSRF).
- **HTML mail** is shown in a sandboxed frame with no scripts and no network. Remote images (tracking pixels) are blocked until you click *Load images*.
- **What Anthropic sees:** for summaries, drafts and chat, the text of the threads involved (long threads are trimmed to the newest messages, and Claude is told when that happens). For *Sort with Claude*, only sender, subject and snippet, never full bodies.
- Google tokens can still die: a password change, revoking access, or 6 months without use. The app shows a *reconnect* button for that account and keeps the others working.

## Not built (yet)

- Sending attachments (you can download received ones), inline `cid:` images, Gmail labels management, "send as" aliases, real-time push (hit refresh).
- Claude calls cost money. Draft, summary, triage and chat each make one or more requests to the model you configured.

## Honest status

- 70 automated tests pass (`npm test`), and the UI was driven in a real browser (desktop and phone width) against a fake Google with a scripted fake Claude.
- **Checked against the live services**: the token endpoint, the Gmail API's error shape and the Anthropic API's key check were hit for real (with deliberately wrong credentials) and are reported correctly by `npm run doctor`.
- **Not tested with a real login**: signing in to a real Google account, reading real mail, and real Claude answers. That needs your credentials. The request shapes follow the official docs, but expect to fix a small thing or two on the very first real run, and tell me what the doctor or the app says.

## Layout

```
src/service.js    accounts + Gmail, one place (used by web, Claude and MCP)
src/gmail.js      Gmail REST client (retries, token refresh)
src/google-auth.js OAuth with PKCE
src/mime.js       parse mail, build replies, header-injection guard
src/claude.js     summarize, draft, triage, chat loop
src/tools.js      the tools Claude may use (shared by chat and MCP)
src/render.js     turns untrusted mail into safe prompt text
src/server.js     local web server and security checks
src/mcp.js        MCP server (stdio)
src/setup.js      npm run setup (guided first run)
src/doctor.js     npm run doctor (checks keys, accounts, port)
public/           the UI, plain JS, no build step
scripts/          fake Google for tests and the demo
```
