#!/usr/bin/env node
// Runs the complete test suite against a disposable local PostgreSQL
// instance, so contributors and CI do not need a manually configured
// DATABASE_URL. The database is stopped whether tests pass or fail.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";

// embedded-postgres calls os.userInfo().uid even though Windows has no POSIX
// uid. On some Windows hosts Node throws ENOMEM from that call before Postgres
// starts. Supply the non-root Windows equivalent before loading the library.
if (process.platform === "win32") {
  os.userInfo = () => ({ uid: 1, gid: 1, username: "postgres", homedir: process.env.USERPROFILE ?? "", shell: "" });
  syncBuiltinESMExports();
}
const { default: EmbeddedPostgres } = await import("embedded-postgres");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Keep PostgreSQL's data path out of the repository and away from Windows
// paths containing spaces; initdb does not reliably quote those paths.
const dataDir = join(tmpdir(), "mai-chat-pgdata-test");
const port = 55433;
const database = "mai_chat_test";
const connectionString = `postgres://postgres:postgres@localhost:${port}/${database}`;
// The production image runs as root so Caddy can bind ports 80 and 443.
// embedded-postgres cannot launch PostgreSQL as root, but it can create an
// unprivileged temporary database user in a Docker container. Keep ordinary
// host runs unchanged: the library warns that creating users mutates the host.
const createPostgresUser = process.platform === "linux" && existsSync("/.dockerenv") && process.getuid?.() === 0;
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: false,
  createPostgresUser,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`test command exited with ${code}`)));
  });
}

try {
  if (!existsSync(join(dataDir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try { await pg.createDatabase(database); } catch (error) {
    if (!String(error?.message ?? error).toLowerCase().includes("already exists")) throw error;
  }
  // Integration tokens are encrypted at rest, so the tests need a key. The
  // database is thrown away after the run, so a fresh random key works and
  // a new checkout or CI never fails for lack of one in .env.
  const env = {
    ...process.env,
    DATABASE_URL: connectionString,
    INTEGRATION_ENCRYPTION_KEY: process.env.INTEGRATION_ENCRYPTION_KEY || randomBytes(32).toString("base64"),
    // The disposable test database has one chat-server process. Do not inherit
    // the production Postgres realtime bus (and its distributed agent-turn
    // lock) from the Docker container: isolated tests must use local room
    // state, otherwise a stale/parallel lock can make WebSocket tests wait for
    // an agent reply that will never be started.
    REALTIME_BUS: "memory",
    // Test WebSocket clients run on localhost. Keeping the deployed public
    // URL here makes the origin guard close those sockets before their first
    // presence event, which turns one rejected connection into many opaque
    // timeouts in the integration suite.
    WEB_APP_URL: "http://localhost:3000",
  };
  // Apply the versioned migrations exactly as a deploy does, then run every
  // workspace's tests against that database.
  await run(npm, ["run", "migrate", "--workspace=packages/db"], env);
  await run(npm, ["run", "test", "--workspaces", "--if-present"], env);
} finally {
  await pg.stop().catch(() => undefined);
}
