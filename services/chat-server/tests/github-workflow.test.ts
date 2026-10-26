import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@mai-chat/db";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { WebSocket } from "ws";
import { closePool, createSession, getPool, upsertUserFromGithub } from "@mai-chat/db";
import { createChatServer, type CreateServerDeps } from "../src/server.js";
import type { GithubClient } from "@mai-chat/integrations";
import type { ToolExecutor } from "../src/tools.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

// This is the release-gate coverage for the full GitHub demo path. It keeps
// the app's own HTTP, WebSocket, action approval, and audit code real while
// replacing only GitHub's network calls and the LLM decision with predictable
// in-process implementations.

let adminCookie: string;

const verifiedGithubClient: GithubClient = {
  listIssues: async () => [],
};

function makeDeps(overrides: Partial<CreateServerDeps> = {}): CreateServerDeps {
  return {
    githubClientFactory: () => verifiedGithubClient,
    slackClientFactory: () => ({ postMessage: async () => {} }),
    githubMcpToolsFactory: async () => [],
    slackMcpToolsFactory: async () => [],
    runAgentTurn: async () => ({ reply: "Agent reply", toolCallsMade: 0 }),
    githubOAuthConfig: {
      clientId: "test-github-client",
      clientSecret: "test-github-secret",
      redirectUri: "http://localhost:4000/auth/github/callback",
      webAppUrl: "http://localhost:3000",
    },
    githubOAuthDeps: {
      exchangeCodeForToken: async () => ({ accessToken: "github-oauth-token" }),
      listRepositoriesForToken: async () => [],
    },
    slackOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    slackOAuthDeps: { exchangeCodeForToken: async () => ({ error: "unused" }) },
    ...overrides,
  };
}

beforeAll(async () => {
  await runMigrations();
  const admin = await upsertUserFromGithub({
    githubId: `github-workflow-admin-${randomUUID()}`,
    username: "github-workflow-admin",
    displayName: "GitHub Workflow Admin",
  });
  adminCookie = `mai_session=${(await createSession(admin.id, 60_000)).token}`;
});

afterAll(async () => {
  await closePool();
});

describe("GitHub workflow release gate", () => {
  it("connects through OAuth, selects a repo, reads, proposes a write, approves it, and records the audit trail", async () => {
    const readCalls: Record<string, unknown>[] = [];
    const writeCalls: Record<string, unknown>[] = [];
    let agentContext: { owner: string; repo: string } | null | undefined;

    const readTool: ToolExecutor = {
      definition: {
        type: "function",
        function: { name: "list_issues", description: "List repository issues", parameters: { type: "object" } },
      },
      execute: async (args) => {
        readCalls.push(args);
        return [{ number: 42, title: "A real issue returned by GitHub" }];
      },
    };
    const writeTool: ToolExecutor = {
      definition: {
        type: "function",
        function: { name: "create_issue", description: "Create a repository issue", parameters: { type: "object" } },
      },
      mutates: true,
      describe: (args) => `Create issue: ${String(args.title)}`,
      preview: (args) => `Title: ${String(args.title)}`,
      execute: async (args) => {
        writeCalls.push(args);
        return { number: 43, url: "https://github.com/acme/demo/issues/43" };
      },
    };

    const { app, server } = createChatServer(
      makeDeps({
        githubMcpToolsFactory: async () => [readTool, writeTool],
        githubOAuthDeps: {
          exchangeCodeForToken: async (code) => {
            expect(code).toBe("github-authorize-code");
            return { accessToken: "github-oauth-token" };
          },
          listRepositoriesForToken: async (token) => {
            expect(token).toBe("github-oauth-token");
            return [
              {
                owner: "acme",
                name: "demo",
                fullName: "acme/demo",
                private: true,
                description: "The demo repository",
                updatedAt: "2026-01-01T00:00:00.000Z",
                htmlUrl: "https://github.com/acme/demo",
              },
            ];
          },
        },
        runAgentTurn: async ({ tools, githubContext }) => {
          agentContext = githubContext;
          const listIssues = tools.find((tool) => tool.definition.function.name === "list_issues");
          const createIssue = tools.find((tool) => tool.definition.function.name === "create_issue");
          expect(listIssues).toBeDefined();
          expect(createIssue).toBeDefined();
          await listIssues!.execute({ owner: "acme", repo: "demo", state: "open" });
          const proposal = await createIssue!.execute({ owner: "acme", repo: "demo", title: "Follow up on issue #42" });
          expect(proposal).toMatchObject({ status: "awaiting_user_confirmation" });
          return { reply: "I found issue #42 and proposed a follow-up issue for approval.", toolCallsMade: 2 };
        },
      })
    );

    const workspace = await request(app)
      .post("/workspaces")
      .set("Cookie", adminCookie)
      .send({ name: `GitHub workflow ${randomUUID()}` });
    expect(workspace.status).toBe(201);
    const workspaceId = workspace.body.id as string;

    // OAuth start returns GitHub's consent URL. The callback uses that same
    // one-time state and stores the fake token before returning to the app.
    const oauthStart = await request(app)
      .get(`/workspaces/${workspaceId}/integrations/github/oauth/start`)
      .set("Cookie", adminCookie);
    expect(oauthStart.status).toBe(302);
    const authorizeUrl = new URL(oauthStart.headers.location);
    expect(authorizeUrl.origin).toBe("https://github.com");
    expect(authorizeUrl.searchParams.get("scope")).toBe("public_repo,read:user");

    const oauthCallback = await request(app)
      .get("/auth/github/callback")
      .set("Cookie", adminCookie)
      .query({ state: authorizeUrl.searchParams.get("state"), code: "github-authorize-code" });
    expect(oauthCallback.status, JSON.stringify(oauthCallback.body)).toBe(302);
    expect(oauthCallback.headers.location).toBe(`http://localhost:3000/w/${workspaceId}?github=connected`);

    const repos = await request(app)
      .get(`/workspaces/${workspaceId}/integrations/github/repos`)
      .set("Cookie", adminCookie);
    expect(repos.status).toBe(200);
    expect(repos.body).toEqual([expect.objectContaining({ fullName: "acme/demo" })]);

    const selectedRepo = await request(app)
      .post(`/workspaces/${workspaceId}/integrations/github/repo`)
      .set("Cookie", adminCookie)
      .send({ owner: "acme", repo: "demo" });
    expect(selectedRepo.status).toBe(200);
    expect(selectedRepo.body).toMatchObject({ type: "github", owner: "acme", repo: "demo" });

    const conversations = await request(app).get(`/workspaces/${workspaceId}/conversations`).set("Cookie", adminCookie);
    expect(conversations.status).toBe(200);
    const conversationId = conversations.body[0].id as string;

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(
      `ws://localhost:${port}/ws?workspaceId=${workspaceId}&conversationId=${conversationId}`,
      { headers: { Cookie: adminCookie } }
    );
    const events: Array<{ type: string; status?: string; message?: { content: string } }> = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));

    try {
      await new Promise<void>((resolve) => socket.on("open", () => resolve()));
      await waitFor(() => events.some((event) => event.type === "history"));
      socket.send(JSON.stringify({ type: "chat", agentKind: "github", content: "Read the open issues and propose a follow-up." }));
      await waitFor(() => events.some((event) => event.type === "agent_status" && event.status === "idle"));

      // The agent works in the one repository this member chose, through
      // their own account.
      expect(agentContext).toMatchObject({ owner: "acme", repo: "demo", access: "unknown" });
      expect(readCalls).toEqual([{ owner: "acme", repo: "demo", state: "open" }]);
      expect(writeCalls).toEqual([]);

      const pending = await request(app)
        .get(`/workspaces/${workspaceId}/actions`)
        .set("Cookie", adminCookie)
        .query({ conversationId });
      expect(pending.status).toBe(200);
      expect(pending.body).toHaveLength(1);
      expect(pending.body[0]).toMatchObject({ toolName: "create_issue", status: "pending", description: "Create issue: Follow up on issue #42" });

      const approval = await request(app)
        .post(`/workspaces/${workspaceId}/actions/${pending.body[0].id}/confirm`)
        .set("Cookie", adminCookie);
      expect(approval.status).toBe(200);
      expect(approval.body).toMatchObject({ status: "confirmed" });
      expect(writeCalls).toEqual([{ owner: "acme", repo: "demo", title: "Follow up on issue #42" }]);

      const audit = await request(app).get(`/workspaces/${workspaceId}/audit`).set("Cookie", adminCookie);
      expect(audit.status).toBe(200);
      expect(audit.body.events.map((event: { eventType: string }) => event.eventType)).toEqual(
        expect.arrayContaining(["integration.connected", "action.proposed", "action.confirmed"])
      );
    } finally {
      socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for workflow event");
}
