# Nexus -- shared agentic workspace

A shared group-chat workspace where a team and an AI teammate read GitHub and
Slack together, live, in one channel. This is a from-scratch rebuild of the
"Multiplayer AI" idea -- not the earlier CRDT collaborative-editor prototype,
which this replaces.

See `docs/spec.md` for the current product spec (idea, what's built, Phase 2 plan). The original spec for the retired prototype is kept for reference at `docs/archive/Multiplayer AI — Problem Statement, Scope & Feature Spec.pdf`.

**Known leftover:** `apps/vscode-extension/`, `services/sync-server/`, and `sample-repo/` are empty directories left over from the retired prototype. They aren't part of the npm workspace and contain nothing, but this session's file tools couldn't remove them (Permission denied on rmdir, likely an OneDrive placeholder/sync lock on those specific folders) — safe to delete by hand in File Explorer whenever convenient.

**Phase 1 scope (what's built):**
- One shared group chat per workspace, in real time over WebSocket.
- Everyone in a workspace sees the same message thread and presence list.
- The agent can **read and summarize** GitHub (issues, PRs, commits) and
  Slack (channels, message history) that a workspace connects, and can also
  **write** to both -- comment on/open a GitHub PR, push a commit, create a
  branch or issue, or post a Slack message -- gated behind a confirmation
  card a human must approve before anything actually happens (see
  `services/chat-server/src/actions.ts`).
- GitHub-authenticated workspaces with shareable join links (see "Scope decisions"
  below for why). Every tool -- GitHub, Slack, Linear, Notion and Figma --
  connects only through its own OAuth login; there is no pasted-token
  option.

## Architecture

npm workspaces monorepo:

- `packages/shared-types` -- the TypeScript contract every other package imports.
- `packages/db` -- Postgres schema + typed CRUD (`workspaces`, `messages`,
  `integrations`). Integration tokens are encrypted at rest (AES-256-GCM).
- `packages/integrations` -- a real GitHub (`@octokit/rest`) client, used
  only to verify a pasted PAT before saving it. Slack has no equivalent
  package here anymore -- its tools come entirely from Slack's own
  official MCP server, see "Slack tools via MCP server" below.
- `services/chat-server` -- Express REST API + a WebSocket server for the
  live chat, and the LLM tool-calling agent loop (OpenAI-compatible
  `/chat/completions`, currently pointed at Groq's free tier).
- `apps/web` -- the Next.js site: create/join a workspace, the chat room,
  and the integrations settings page.

Every package that talks to something external (the LLM, GitHub, Slack)
takes that dependency as an injectable parameter, so the test suites
exercise the real logic end-to-end and only mock the one non-deterministic
network call -- see each package's `tests/`.

## Running it locally

You need Node 20+ and a Postgres database. If you don't already have one
running, this repo can start a real, local Postgres for you with no
install or admin rights needed:

```sh
npm install
npm run db:start        # leave this running in its own terminal
```

(First run initializes a real Postgres 18 server under `.pgdata/`, using the
`embedded-postgres` package -- a genuine Postgres binary, not a mock. If you
already have Postgres running elsewhere, skip this and just point
`DATABASE_URL` in `.env` at it instead.)

In another terminal:

```sh
npm run build            # builds every package, in dependency order
npm run migrate          # applies pending migrations in packages/db/sql/migrations (see "Database migrations")
npm run dev:server       # starts the chat server on :4000
```

And in a third terminal:

```sh
npm run dev:web          # starts the website on :3000
```

Open **http://localhost:3000**, create a workspace, open the same URL (or
use the join code) in a second browser/incognito window as a second person,
and chat -- you'll see each other's messages and the agent's replies live.
From the workspace's "Integrations settings" page you can log in with
GitHub, Slack, Linear, Notion or Figma. Each tool connects through its own
OAuth login only.

`.env` is set up to run the agent against a local, free, open-source model
by default -- see the next section for the one-time setup. If you'd rather
use Groq's hosted free tier instead (faster replies, but a real rate limit
and daily quota), `.env`'s commented-out `AGENT_LLM_*` block has a working
key ready to swap in.

For a production-style run instead of the dev servers: `npm run build` then
`npm run start:server` and `npm run start:web`.

## Running the agent for free, without a cloud API key

The agent talks to any OpenAI-compatible `/chat/completions` endpoint
(`services/chat-server/src/llm-client.ts`), which is what makes this
possible: [Ollama](https://ollama.com) serves that exact API from a model
running entirely on your own machine, so `.env` just points at
`localhost` instead of a cloud provider. No API key, no rate limit, no
daily quota, no cost -- the only limit becomes your own hardware's speed,
which is the tradeoff worth knowing going in: local CPU inference (no
dedicated GPU) is noticeably slower per reply than a hosted service like
Groq.

One-time setup:

1. Install Ollama: <https://ollama.com/download> (Windows/macOS/Linux).
2. Pull a model that supports tool calling. `qwen2.5:7b-instruct` is a
   good default for a machine with 16-32GB of RAM and no dedicated GPU --
   small enough to run on CPU, still reliable across a modest tool schema:
   ```sh
   ollama pull qwen2.5:7b-instruct
   ```
   If replies feel too slow, `llama3.2:3b` is much faster but less
   reliable at picking the right tool among many; if you have a GPU with
   8GB+ VRAM (or an Apple Silicon Mac), `gpt-oss:20b` is the same model
   this project was originally tested against on Groq, just running
   locally.
3. Build a custom tag with a bigger context window -- **this step matters**:
   Ollama silently caps every model at a 2048-token context window unless
   told otherwise, and this project's tool schema alone (whatever Slack
   and GitHub MCP tools are configured -- see the next two sections) can
   already be well over that. Skipping this step doesn't error, it just
   means the model quietly never sees its own tools.
   ```sh
   ollama create mai-agent -f scripts/ollama/Modelfile.mai-agent
   ```
   (Edit that file's `FROM` line first if you pulled a different model
   than `qwen2.5:7b-instruct`.)
4. That's it -- Ollama's background service serves `http://localhost:11434`
   automatically once installed, and `.env`'s default `AGENT_LLM_*` values
   already point at it. Just restart `npm run dev:server`.

`services/chat-server/src/token-budget.ts` sizes how much conversation
history the agent includes each turn against `AGENT_LLM_TPM_LIMIT` in
`.env` -- keep that in sync with whatever `num_ctx` you set in the
Modelfile (see its comments), the same way it was kept in sync with Groq's
actual per-minute quota.

## GitHub tools via MCP server

The agent's GitHub tools (issues, pull requests, files, commits,
branches, ...) come from
[GitHub's own official MCP server](https://github.com/github/github-mcp-server)
(`github/github-mcp-server`) rather than a hand-rolled wrapper this
project maintains itself. It runs as a local Docker container that the
chat-server talks to over stdio (`docker run -i --rm ...`,
`services/chat-server/src/github-mcp-pool.ts`), one container per
workspace that's connected GitHub (see that file's comments for why
one-per-workspace, not one shared container).

Setup:

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
   and make sure it's actually **running** (the whale icon in your system
   tray/menu bar) -- `docker run` needs the Docker Desktop background
   service, not just the CLI.
2. `npm install` at the repo root (this adds the
   `@modelcontextprotocol/sdk` dependency the chat-server now needs), then
   restart `npm run dev:server`.

That's it -- no image to pull ahead of time (the first GitHub tool call
after connecting a repo triggers `docker run`, which pulls
`ghcr.io/github/github-mcp-server` automatically if it isn't local yet --
that first call will be slower while the image downloads), and no path to
configure. Connecting a GitHub repo from the app (the "Connect GitHub" or
"+ Add channel" OAuth flow) gets its tools from this container instead.
If Docker Desktop isn't running yet, connecting GitHub still works fine
(the token/repo get saved), the agent just has no GitHub tools until it
is -- check the chat-server's terminal for a `GitHub MCP tools
unavailable` log line if that happens unexpectedly, and for
`docker: command not found` specifically, restart your terminal / VS
Code / `npm run dev:server` after installing Docker Desktop so its PATH
change takes effect.

**Why not the server's full tool set.** GitHub's MCP server can expose
its entire surface (every toolset it has), but this project ships a
curated default of 14 tools (`GITHUB_TOOLS` in `.env`, defined in
`github-mcp-pool.ts`'s `DEFAULT_GITHUB_TOOLS`) instead of that, or even
its own "default" toolset (`context,repos,issues,pull_requests,users`).
Reason: this server's tools are "mega-tools" that dispatch many
operations through one `method` argument (e.g. one `issue_read` tool
covers get/list/list-types), which makes each individual tool's
description quite long -- measured directly against the real v1.12.2 tool
descriptions on 2026-09-21, just that one built-in "default" toolset
already comes out to roughly 8,000-12,000 tokens of schema JSON, which is
*at or past* this project's entire local-Ollama context window
(`AGENT_LLM_TPM_LIMIT=8192`) by itself, before the system prompt, Slack's
tools, or a single word of conversation history are added. The shipped
14-tool default leaves real room for history instead.

To change which GitHub tools are available:

- `GITHUB_TOOLS` -- an explicit comma-separated allow-list of individual
  tool names (what the default above is). Full tool list:
  <https://github.com/github/github-mcp-server#tools>.
- `GITHUB_TOOLSETS` -- whole categories instead (`repos`, `issues`,
  `pull_requests`, `actions`, `code_security`, ... or `all` for
  everything). See
  <https://github.com/github/github-mcp-server#available-toolsets>.
  Combines additively with `GITHUB_TOOLS` if both are set.
- `GITHUB_MCP_DOCKER_IMAGE` -- pins a specific image tag/digest instead of
  always pulling GitHub's latest published image (e.g.
  `ghcr.io/github/github-mcp-server:v1.12.2`).

Whichever you choose, **watch the chat-server's own terminal** after
sending a chat message once GitHub is connected -- `agent.ts` logs the
real, measured token cost of whatever's configured
(`[agent] tool schema ~N tok, system prompt ~N tok, history budget ~N
tok ...`) every turn, so you can see exactly how much room (if any) is
left for conversation history rather than guessing from the numbers
above, which are this project's own measurement, not a guarantee for
whatever tool set you end up choosing. If a GitHub-connected chat starts
feeling like the agent has no memory of the last few messages, that log
line is the first thing to check -- trim `GITHUB_TOOLS` further, or raise
`AGENT_LLM_TPM_LIMIT` together with a bigger `num_ctx` in your Ollama
Modelfile (see the section above) if your hardware can take it.

**Sign Up and Sign In:** the landing page remains public and offers both
controls in the header. Three ways to sign in, side by side in the same
dialog (`apps/web/app/_components/AuthForm.tsx`):

- **Email + password** (`services/chat-server/src/email-auth.ts`) --
  always available, no OAuth app to register. Sign-up requires a name, a
  valid email, and a password of at least 12 characters; passwords are
  hashed with scrypt (`services/chat-server/src/passwords.ts`, OWASP's
  32 MiB configuration) and verified in constant time. Per-IP and
  per-account rate limiting (`GET /auth/providers` reports which methods
  are actually configured, so the UI never shows a broken provider
  button).
- **GitHub OAuth** -- see the OAuth App setup earlier in this section
  (`GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`); the same App
  used for the GitHub integration also handles sign-in, distinguished by a
  `login:`-prefixed OAuth state on the shared `/auth/github/callback` URL.
- **Google OAuth** (`services/chat-server/src/google-auth.ts`), PKCE +
  `state` verified with a browser-bound cookie, identity taken only from
  Google's authenticated `userinfo` endpoint with `email_verified: true`
  required -- never an unverified ID token or a bare email match. To
  enable it:
  1. Create an OAuth 2.0 Client ID at
     <https://console.cloud.google.com/apis/credentials> (type: "Web
     application").
  2. Add this **Authorized redirect URI**:
     `http://localhost:4000/auth/login/google/callback`
  3. Paste the Client ID and Client Secret into `.env`:
     ```
     GOOGLE_OAUTH_CLIENT_ID=
     GOOGLE_OAUTH_CLIENT_SECRET=
     ```
  Leaving these blank doesn't break the app -- the Google button just
  shows "Google sign-in isn't configured yet. Use email or GitHub for
  now." Google's redirect URI is built from `CHAT_SERVER_PUBLIC_URL`, same
  as the GitHub/Slack flows above.

First successful login/signup on any of the three creates the account;
returning users reuse it (email+password by email, GitHub/Google by their
own stable provider id -- never linked across providers by email address).
Creating or joining a workspace, opening a shared workspace link, and using
workspace APIs or chat all require a valid session. Workspace names and
join codes entered before login are preserved on return. Sessions use
HTTP-only cookies (30-day expiry) and can be revoked through Sign Out.

## Slack tools via MCP server

The agent's Slack tools (search, reading channels/threads, posting a
message, ...) come from
[Slack's own official MCP server](https://docs.slack.dev/ai/slack-mcp-server/)
(`https://mcp.slack.com/mcp`) rather than a hand-rolled wrapper this
project maintains itself -- the same move GitHub's tools already made,
just remote instead of a local Docker container: there's no process to
start here, `services/chat-server/src/slack-mcp-pool.ts` just opens an
authenticated HTTP connection per workspace.

Unlike GitHub, there's no pasted-token option for Slack: Slack's MCP
server only accepts a real *user* access token minted by a specific OAuth
flow (`services/chat-server/src/slack-oauth.ts`), not an arbitrary bot
token. Setup:

1. Create a Slack App at <https://api.slack.com/apps> -- an app marked
   **internal** to your own workspace is enough; Slack's MCP server
   refuses an app that's neither internal nor published to the Slack
   Marketplace.
2. Add a Redirect URL of `http://localhost:4000/auth/slack/callback`
   (matching `CHAT_SERVER_PUBLIC_URL` if you've changed it) and the user
   scopes listed in `services/chat-server/src/slack-oauth.ts`'s
   `SLACK_USER_SCOPES` (channel/group/DM listing *and* history, search,
   `chat:write`, `users:read`) under the app's **User Token Scopes**
   section specifically -- not Bot Token Scopes, which the MCP server
   ignores entirely. Slack's app-creation form may also ask for a minimal
   bot scope (e.g. `users:read`) as a one-time workaround -- that bot
   identity is never actually used at runtime.
3. Copy the Client ID and Client Secret from the app's "Basic Information"
   page into `.env`'s `SLACK_OAUTH_CLIENT_ID` / `SLACK_OAUTH_CLIENT_SECRET`,
   then restart `npm run dev:server`.
4. **Enable MCP access for the app** at
   `https://api.slack.com/apps/<your app id>/app-assistant` (Features ->
   Agents & AI Apps -> Model Context Protocol). Found live 2026-09-21: an
   otherwise fully-configured app still gets rejected by
   `mcp.slack.com` with `"App is not enabled for Slack MCP server
   access"` until this separate toggle is turned on -- it's not implied
   by adding scopes or completing OAuth.
5. From the app, click "+ Add channel -> Slack" or the Integrations
   settings page's "Log in with Slack" button.

If Slack login isn't configured yet, connecting Slack shows a clear "Slack
login isn't configured on this server" error rather than failing oddly.
Once connected, messages the agent reads or posts happen as *whichever
Slack account did the login* -- this is how Slack's MCP server itself
works (a user token, not a separate bot identity), not a limitation of
this project's own code.

**Live-verified 2026-09-21** against a real Slack App and account --
`oauth.v2.user.access`'s response does use the plain `access_token` /
`team.name` shape this code originally guessed, so no field-name fix was
needed there. Two other things *did* need fixing after a real login, both
already applied here and worth knowing if you're troubleshooting your own
setup:
- The `/oauth/v2_user/authorize` endpoint takes its scopes under the
  plain `scope` query parameter, not `user_scope` (which only applies to
  Slack's older combined bot+user endpoint) -- using the wrong name gets
  you Slack's `"Invalid permissions requested / No scopes requested"`
  error even with a fully-configured app.
- The app-level **Model Context Protocol** toggle mentioned in step 4
  above has to be turned on separately -- Slack's error message when it
  isn't is explicit (`"App is not enabled for Slack MCP server
  access"`), so if you see that, this is almost certainly it.

If your own first login fails at the callback step for some other
reason, check the chat-server's own terminal -- `slack-oauth.ts` logs
Slack's raw token-endpoint response there, which is the fastest way to
spot what's actually wrong.


## Tests

```sh
npm run test
```

Runs every package's suite (`packages/db`, `packages/integrations`,
`services/chat-server`) against a real Postgres and real dependency-injected
mocks for GitHub/Slack/the LLM call -- see the "Architecture" note above.
`packages/shared-types` is type-only; its "test" is `tsc` during `build`.

## Scope decisions (Phase 1)

A few things were deliberately simplified to ship a genuinely working,
fully-tested product quickly rather than a half-built bigger one:

- **Authenticated join-link workspaces.** A GitHub account is required before creating or joining a workspace. A shared link or code still grants access once signed in; role-based permissions remain deferred.
- **OAuth only, for every tool.** GitHub connects through a real OAuth
  login (`services/chat-server/src/github-oauth.ts`); Linear, Notion and
  Figma through `services/chat-server/src/provider-oauth.ts`. Tokens are
  encrypted at rest and never pasted by hand. Slack connects via OAuth
  (`services/chat-server/src/slack-oauth.ts`) -- Slack's own official MCP
  server (see "Slack tools via MCP server" above) requires a real user
  access token from that exact flow, so a hand-pasted bot token (what this
  project used before switching Slack's tools to that MCP server) could
  never authenticate to it.
- **Read AND write, gated by human confirmation.** The agent can look
  things up on GitHub/Slack, and can also act (comment/open a PR/push a
  commit/create an issue or branch on GitHub, post a message on Slack) --
  every write queues a confirmation card in the chat instead of running
  immediately; see `services/chat-server/src/actions.ts`.

## What's verified, and how

- Every package's automated test suite runs against a real local Postgres,
  with only the external network call (GitHub/Slack API, the LLM call)
  swapped for a scripted mock in each specific test -- never the surrounding
  logic.
- The whole system was additionally verified with real Playwright browser
  automation: two independent browser contexts (two "people") creating and
  joining the same workspace through the real website, seeing each other's
  messages and the agent's reply live over WebSocket, chat history
  surviving a reload (proving it's persisted, not just in-memory), and a
  bad GitHub token being rejected by the real GitHub API.
- That Playwright pass ran with the LLM call scripted rather than hitting
  Groq for real, because the verification sandbox's network policy blocks
  outbound access to `api.groq.com` -- a sandbox limitation, not a product
  one. `services/chat-server/tests/agent.test.ts` covers the real
  tool-calling loop against a scripted LLM response in detail, and the same
  Groq key already works from a normal internet connection (this repo
  reuses a key that was verified working in this project's earlier build).
- The whole monorepo was also rebuilt and re-tested from a fresh checkout
  (fresh `npm install`, fresh database) before being copied here, to catch
  anything that only worked by accident of leftover local state.

## Database migrations

Schema changes live in `packages/db/sql/migrations` as numbered files (`0001_baseline.sql`, `0002_...sql`). Each file is applied once, in order, inside a transaction, and recorded in the `schema_migrations` table with a checksum. Deploys run `npm run migrate` on start.

- Add a change: create the next numbered file, e.g. `0002_add_task_labels.sql`. Never edit a migration that has already been applied.
- Make it reversible: add `0002_add_task_labels.down.sql` next to it.
- See what has run: `npm run migrate:status --workspace=packages/db`.
- Undo the latest: `npm run migrate:down --workspace=packages/db` (needs its `.down.sql`).
