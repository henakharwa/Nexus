# Production secrets and health checks

Nexus runs on the Oracle VM described in `docs/deploy-oracle-cloud.md`. Keep
all credentials in `.env.oracle` on that VM (`chmod 600 .env.oracle`). Do not
place them in source files, Docker build arguments, browser-visible
`NEXT_PUBLIC_*` variables, screenshots, issues, or chat logs. The repository
ignores `.env` and `.env.oracle`; commit only `.env.example` and
`.env.oracle.example`, which must contain blank or local safe values.

## Secrets in `.env.oracle`

- `POSTGRES_PASSWORD` — the VM's own PostgreSQL database (`docker-compose.oracle.yml`
  builds `DATABASE_URL` from it).
- `INTEGRATION_ENCRYPTION_KEY` — legacy single-key configuration. For key rotation, use `INTEGRATION_ENCRYPTION_KEYS` as `new-key-id=<base64-32-byte-key>,old-key-id=<base64-32-byte-key>`, deploy it, run `npm run rotate:integration-keys --workspace=packages/db`, then remove the old key only after the rotation succeeds. Changing a single legacy key directly makes previously stored
  integration tokens unreadable, so rotate deliberately.
- `AGENT_LLM_API_KEY` and the matching `AGENT_LLM_BASE_URL` / `AGENT_LLM_MODEL`
  (plus the optional `AGENT_LLM_PRIMARY_*` values).
- OAuth client secrets: `GITHUB_OAUTH_CLIENT_SECRET`, `SLACK_OAUTH_CLIENT_SECRET`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `LINEAR_OAUTH_CLIENT_SECRET`,
  `NOTION_OAUTH_CLIENT_SECRET`, and `FIGMA_OAUTH_CLIENT_SECRET`, with their
  client IDs. They are not exposed to the browser by this app.
- Email delivery: `RESEND_API_KEY`, or the `GMAIL_*` values.

The public URLs (`WEB_APP_URL`, `CHAT_SERVER_PUBLIC_URL`,
`NEXT_PUBLIC_CHAT_SERVER_URL`, `NEXT_PUBLIC_CHAT_SERVER_WS_URL`) are derived
from `NEXUS_DOMAIN` in `docker-compose.oracle.yml`.

## Rotation and verification

1. Rotate a provider credential in the provider dashboard if it has ever
   appeared in a committed file, screenshot, or shared chat.
2. Update it in `.env.oracle`, then redeploy:
   `docker compose --env-file .env.oracle -f docker-compose.oracle.yml up -d`.
3. Reconnect the affected integration in the product if the provider token
   itself was rotated.
4. Confirm `https://YOUR_DOMAIN/api/healthz` returns a successful liveness
   response and `/api/readyz` reports `database: "connected"`.

The application emits structured JSON log lines only for HTTP failures,
unhandled HTTP errors, and failed readiness checks. These records contain
request metadata and error messages, never request bodies, cookies, tokens, or
configured secrets.
