import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    // Suites create many workspaces, agents and invitations from one user.
    // Keep the scope 14 abuse limits out of their way;
    // tests/internal/abuse-cost.internal.test.ts lowers them on purpose.
    env: {
      WORKSPACES_PER_USER_PER_DAY: "100000",
      AGENTS_PER_USER_PER_HOUR: "100000",
      INVITES_PER_WORKSPACE_PER_HOUR: "100000",
      INVITES_PER_USER_PER_DAY: "100000",
      AI_GENERATIONS_PER_USER_PER_HOUR: "100000",
      WORKFLOW_RUNS_PER_USER_PER_HOUR: "100000",
    },
  },
  resolve: {
    alias: {
      "@mai-chat/shared-types": path.resolve(dirname, "../../packages/shared-types/src/index.ts"),
      "@mai-chat/db": path.resolve(dirname, "../../packages/db/src/index.ts"),
      "@mai-chat/integrations": path.resolve(dirname, "../../packages/integrations/src/index.ts"),
    },
  },
});
