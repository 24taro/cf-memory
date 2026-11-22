# cf-memory

Memory for your coding agents, in your own Cloudflare account. Every prompt and
final reply is kept word for word and found again by keyword. No vector
database, no model calls.

[日本語](README.ja.md)

Claude Code and Codex forget what you worked out yesterday. cf-memory is a
Cloudflare Worker plus a small hook plugin: the hooks record each turn, and at
the start of every prompt they put the related notes and past conversations
back in front of the agent.

cf-memory is an independent project. It runs on Cloudflare and is not affiliated
with or endorsed by Cloudflare, Inc.

The initial release supports one owner per instance using a fixed API token.
[Team mode](docs/TEAM-MODE.md) is experimental.

## Install

You need a Cloudflare account on the Workers Paid plan with R2 enabled, Git,
Bash, Node.js 22.12+ (22.x) or 24+ with npm, OpenSSL, and curl. To connect an
agent, install Claude Code 2.1.327 or later, or Codex. If an older Claude Code
version is installed, update it before running the installer. The installer
checks the Claude Code version before deploying or changing any client settings.
Run `./install.sh --no-client` to deploy the Worker on its own.

```bash
git clone https://github.com/24taro/cf-memory.git
cd cf-memory
./install.sh
```

The script logs you in to Cloudflare, creates two D1 databases and an R2 bucket,
deploys the Worker, generates your API token, checks that the server answers,
and connects Claude Code and Codex if they are installed.

If you use Codex, add the two export lines printed by the installer to your
shell profile and load it before launching Codex. Open `/hooks` and approve
the four cf-memory hooks. If Codex asks again after an update, review and
approve the new hooks there.

To verify recording and recall, tell your agent a test fact and ask it to
repeat the fact in its final reply. Start a new session in the same Git
repository and ask for that fact. To check the connection and hook status, run:

```bash
node cf-memory-agent/scripts/agent.mjs doctor
```

To update, pull the latest changes in the same checkout and run `./install.sh`
again. Use the same Cloudflare account and keep `.cf-memory.secrets` to reuse
the API token. The databases and bucket are reused.

## How it works

1. **Record.** Hooks keep each prompt and the agent's final reply in full, plus
   one line per tool action and the head of failed output. Text is scrubbed for
   secrets on your machine before it is sent. Nothing is summarized.
2. **Recall.** On every prompt the hook searches your notes and skills by
   keyword and injects the matches. At session start it injects your core memory
   and the last reply of the previous session in the same repository.
3. **Search.** When the agent needs older context it searches the kept
   conversation itself (`log_search`, `log_read`) and saves what is worth
   keeping as a note (`notes_put`).

```mermaid
flowchart LR
  A[Claude Code / Codex] -- hooks: prompt, reply, actions --> P[cf-memory agent]
  P -- log_append --> W[Worker]
  W --> L[(D1: conversation log)]
  W --> N[(D1: notes, skills, core memory)]
  W --> R[(R2: skill files)]
  A -- MCP: recall, log_search, notes_put --> W
```

Search is keyword-only: SQLite FTS5 trigram indexes over notes and
conversations, with a substring fallback for one- and two-character queries.
It works for Japanese and English.

## Where your data lives

Everything is stored in D1 and R2 in your own Cloudflare account. The only
network destination is your Worker. The API token is in `.cf-memory.secrets` in
this checkout (mode 0600, ignored by git) and in your agent's MCP configuration.

Prompts and final replies are kept until you delete them. Tool-action lines and
error heads are deleted after 90 days (`LOG_ACTION_RETENTION_DAYS`).

## Cost

cf-memory is built for the Workers Paid plan. The Free plan allows 5 million D1
rows read per day, and one heavy day of the author's own use read about 8
million, so on the Free plan it can stop answering until the next day.

## Uninstall

To disconnect your agent, run the commands for the client you installed:

```bash
node cf-memory-agent/scripts/agent.mjs uninstall --client claude-code
claude mcp remove cf-memory --scope user

node cf-memory-agent/scripts/agent.mjs uninstall --client codex
codex mcp remove cf-memory
```

For Codex, also remove the `CF_MEMORY_MCP_URL` and `CF_MEMORY_ACCESS_TOKEN`
export lines from your shell profile and open a new shell. The uninstaller
keeps the local spool and diagnostics in `~/.cf-memory/v3`.

To permanently remove the hosted instance and its data, select its Cloudflare
account and run:

```bash
npx wrangler delete
npx wrangler d1 delete cf-memory
npx wrangler d1 delete cf-memory-logs
npx wrangler r2 bucket delete cf-memory-bundles
```

Empty the R2 bucket first if it contains objects. If you set up Cloudflare
Access or a custom domain, remove the associated settings in Cloudflare. Once
you no longer need the API token, delete `.cf-memory.secrets` from the checkout.

## More

- [Web pages behind Cloudflare Access](docs/WEB-ACCESS.md): read and edit your notes in a browser.
- [Experimental team mode](docs/TEAM-MODE.md): several people on one instance, with an OAuth authorization server.
- [The agent plugin](cf-memory-agent/README.md): what each hook does, the local spool, settings.
- [Security](SECURITY.md): the trust model and how to report a problem.

## Develop

```bash
npm ci
npm run typecheck
npm test -- --maxWorkers=1
npm run dev
```

## License

[MIT](LICENSE)
