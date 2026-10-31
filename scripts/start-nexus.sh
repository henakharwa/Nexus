#!/bin/sh
set -eu
public_port="${PORT:?PORT is required}"
if [ "${RESET_DATABASE_ON_START:-}" = "DELETE_ALL_USERS_AND_WORKSPACES" ]; then
  echo "RESET_DATABASE_ON_START is set; clearing all workspace and user data."
  CONFIRM_DATABASE_RESET=DELETE_ALL_USERS_AND_WORKSPACES node scripts/reset-database.mjs
fi
# Start each part with node directly: the runtime image has no npm (its
# bundled dependencies kept failing the Trivy image scan). The working
# folders match what `npm run --workspace=...` used.
(
  cd /app/packages/db
  node /app/node_modules/tsx/dist/cli.mjs src/migrate.ts
)
(
  cd /app/services/chat-server
  PORT=4000 exec node dist/index.js
) &
chat_pid=$!
(
  cd /app/apps/web
  PORT=3000 exec node /app/node_modules/next/dist/bin/next start -H 127.0.0.1
) &
web_pid=$!
trap 'kill "$chat_pid" "$web_pid" 2>/dev/null || true' INT TERM EXIT
caddy_config="${CADDY_CONFIG:-/app/Caddyfile.oracle}"
PORT="$public_port" exec caddy run --config "$caddy_config" --adapter caddyfile
