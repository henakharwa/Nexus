# Move Nexus from Render to Oracle Cloud Always Free

This deployment keeps the existing single public origin. Caddy sends `/api/*`
and WebSockets to the chat server while it sends all other requests to Next.js.
PostgreSQL runs on the Oracle VM with a persistent Docker volume.

## Before the cutover

1. Use a domain you control, such as `nexus.example.com`.
2. In Render, record every environment variable. Keep the current
   `INTEGRATION_ENCRYPTION_KEY` exactly as it is. Changing it after importing
   the database makes existing encrypted integration tokens unreadable.
3. Export the Render PostgreSQL database from a computer with PostgreSQL client
   tools installed:

   ```bash
   pg_dump "$RENDER_DATABASE_URL" --format=custom --no-owner --file=nexus-render.dump
   ```

4. Keep the Render service and database until the Oracle deployment passes the
   checks in the final section.

## Create the Oracle VM

1. Create an Always Free eligible Ubuntu Arm VM in the Oracle Cloud home
   region. Use no more than the Always Free total of 2 OCPUs and 12 GB memory.
2. In the VCN security list or network security group, allow inbound TCP ports
   `80` and `443`. Restrict SSH port `22` to your own IP address.
3. Point the domain `A` record at the VM public IPv4 address. Wait for DNS to
   resolve before starting Caddy, because Caddy uses the domain to issue TLS.
4. Connect by SSH and install Docker:

   ```bash
   sudo apt update
   sudo apt install -y ca-certificates curl git
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER
   exit
   ```

   Sign in again after the last command.

## Deploy the application

1. Clone the private repository on the VM:

   ```bash
   git clone YOUR_REPOSITORY_URL nexus
   cd nexus
   ```

2. Create the deployment environment file. Copy all secrets from Render, use a
   strong new `POSTGRES_PASSWORD`, and keep the old integration encryption key:

   ```bash
   cp .env.oracle.example .env.oracle
   chmod 600 .env.oracle
   nano .env.oracle
   ```

   To use OpenAI `gpt-6-luna` as the paid primary while retaining the current
   OpenAI-compatible provider as a fallback, keep the existing `AGENT_LLM_*`
   values and add:

   ```env
   AGENT_LLM_PRIMARY_BASE_URL=https://api.openai.com/v1
   AGENT_LLM_PRIMARY_API_KEY=YOUR_OPENAI_API_KEY
   AGENT_LLM_PRIMARY_MODEL=gpt-6-luna
   AGENT_LLM_PRIMARY_MAX_TOKENS=1024
   AGENT_LLM_PRIMARY_TPM_LIMIT=8192
   ```

   Nexus only uses the fallback when OpenAI explicitly reports exhausted
   credits or billing quota. Normal transient rate limits remain on the paid
   provider and use its retry policy.

3. Start PostgreSQL only, then import the Render backup:

   ```bash
   docker compose --env-file .env.oracle -f docker-compose.oracle.yml up -d postgres
   docker cp nexus-render.dump $(docker compose --env-file .env.oracle -f docker-compose.oracle.yml ps -q postgres):/tmp/nexus-render.dump
   docker compose --env-file .env.oracle -f docker-compose.oracle.yml exec -T postgres \
     pg_restore --clean --if-exists --no-owner -U nexus -d multiplayer_ai /tmp/nexus-render.dump
   ```

   If you changed `POSTGRES_USER` or `POSTGRES_DB`, replace `nexus` and
   `multiplayer_ai` in the final command.

4. Start Nexus. The service applies the current database schema on startup:

   ```bash
   docker compose --env-file .env.oracle -f docker-compose.oracle.yml up -d --build
   docker compose --env-file .env.oracle -f docker-compose.oracle.yml logs -f nexus
   ```

## Update external providers

Replace the Render callback URL in each provider console:

| Provider | Callback URL |
| --- | --- |
| GitHub | `https://YOUR_DOMAIN/api/auth/github/callback` and `https://YOUR_DOMAIN/api/auth/login/github/callback` |
| Google | `https://YOUR_DOMAIN/api/auth/login/google/callback` |
| Slack | `https://YOUR_DOMAIN/api/auth/slack/callback` |
| Linear | `https://YOUR_DOMAIN/api/auth/mcp/linear/callback` |
| Notion | `https://YOUR_DOMAIN/api/auth/mcp/notion/callback` |
| Figma | `https://YOUR_DOMAIN/api/auth/mcp/figma/callback` |

## Verify and cut over

1. Confirm the app loads at `https://YOUR_DOMAIN` with no startup page.
2. Confirm `https://YOUR_DOMAIN/api/healthz` succeeds.
3. Confirm `https://YOUR_DOMAIN/api/readyz` reports `database: connected`.
4. Test sign-in, chat in two browser profiles, a notification, one workflow,
   one artifact, and one integration reconnection.
5. Keep Render available for one day. When all checks pass, take a final
   database backup and remove the Render service and database.

## Operations

The `nexus` container runs as the unprivileged `node` user (uid 1000) with
no Linux capabilities. A one-off `volume-permissions` step in
`docker-compose.oracle.yml` hands Caddy's certificate volumes to that user
before Nexus starts, so upgrading from an older root-run version keeps the
existing certificate.

Deploy a new version:

```bash
git pull
docker compose --env-file .env.oracle -f docker-compose.oracle.yml up -d --build
```

The deployment keeps Caddy's certificate data in Docker volumes. Do not remove
`caddy_data` or `caddy_config` (for example with `docker compose down -v`)
unless you intend to replace the TLS certificate. Removing them forces a new
certificate request and can trigger the certificate authority's rate limits.

Back up PostgreSQL regularly:

```bash
docker compose --env-file .env.oracle -f docker-compose.oracle.yml exec -T postgres \
  pg_dump -U nexus -d multiplayer_ai --format=custom > nexus-backup-$(date +%F).dump
```
