import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { getPool, closePool, runMigrations, rollbackLastMigration, listAppliedMigrations } from "../src/index.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

let dir: string;
beforeAll(async () => {
  await runMigrations();
  dir = await mkdtemp(path.join(tmpdir(), "mai-migrations-"));
  await writeFile(path.join(dir, "9001_create_probe.sql"), "CREATE TABLE migration_probe (id INT PRIMARY KEY);");
  await writeFile(path.join(dir, "9002_add_probe_column.sql"), "ALTER TABLE migration_probe ADD COLUMN label TEXT;");
  await writeFile(path.join(dir, "9002_add_probe_column.down.sql"), "ALTER TABLE migration_probe DROP COLUMN label;");
});
afterAll(async () => {
  await getPool().query("DROP TABLE IF EXISTS migration_probe");
  await getPool().query("DELETE FROM schema_migrations WHERE version IN ('9001', '9002')");
  await rm(dir, { recursive: true, force: true });
  await closePool();
});

describe("versioned migrations", () => {
  it("applies pending files once, in order, and records them", async () => {
    expect(await runMigrations({ dir })).toEqual(["9001", "9002"]);
    expect(await runMigrations({ dir })).toEqual([]);
    const versions = (await listAppliedMigrations()).map((row) => row.version);
    expect(versions).toEqual(expect.arrayContaining(["0001", "9001", "9002"]));
    await getPool().query("INSERT INTO migration_probe (id, label) VALUES (1, 'ok')");
  });

  it("rolls back the latest migration with its .down.sql and refuses one without", async () => {
    expect(await rollbackLastMigration({ dir })).toBe("9002");
    const columns = await getPool().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'migration_probe'");
    expect(columns.rows.map((row) => row.column_name)).toEqual(["id"]);
    await expect(rollbackLastMigration({ dir })).rejects.toThrow(/no \.down\.sql/);
  });

  it("rolls back a failed migration without recording it", async () => {
    await writeFile(path.join(dir, "9003_broken.sql"), "CREATE TABLE migration_probe_two (id INT); SELECT * FROM table_that_does_not_exist;");
    await expect(runMigrations({ dir })).rejects.toThrow(/9003_broken failed/);
    const exists = await getPool().query("SELECT to_regclass('migration_probe_two') AS t");
    expect(exists.rows[0].t).toBeNull();
    expect((await listAppliedMigrations()).some((row) => row.version === "9003")).toBe(false);
    await rm(path.join(dir, "9003_broken.sql"));
  });
});

describe("0007: databases migrated before the 0001_baseline edit", () => {
  // Production applied 0001_baseline.sql before it was edited on 2026-10-08,
  // so it logged "changed after it was applied" on every start.
  const OLD_BASELINE = "3a818bdbbad064feb37993deca713442e2b3c71ffa7dbcc8b6ef1adbd8d74ea6";

  it("adopts the edited baseline and stops the warning", async () => {
    // Put this database back in production's state: the old checksum, the
    // old column default, and 0007 not yet applied.
    await getPool().query("UPDATE schema_migrations SET checksum = $1 WHERE version = '0001'", [OLD_BASELINE]);
    await getPool().query("DELETE FROM schema_migrations WHERE version = '0007'");
    await getPool().query(`ALTER TABLE workspace_permission_policies ALTER COLUMN editor_permissions SET DEFAULT '{"connectTools":true}'::jsonb`);

    const firstRun: string[] = [];
    expect(await runMigrations({ log: (message) => firstRun.push(message) })).toEqual(["0007"]);
    // The run that applies 0007 still notices the old checksum once.
    expect(firstRun.some((message) => message.includes("0001_baseline changed"))).toBe(true);

    const nextRun: string[] = [];
    expect(await runMigrations({ log: (message) => nextRun.push(message) })).toEqual([]);
    expect(nextRun.filter((message) => message.startsWith("warning"))).toEqual([]);

    const defaults = await getPool().query(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'workspace_permission_policies' AND column_name = 'editor_permissions'"
    );
    expect(defaults.rows[0].column_default).toContain("manageWorkflows");
  });
});
