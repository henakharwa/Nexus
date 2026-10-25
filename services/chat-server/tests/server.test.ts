import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { runMigrations } from "@mai-chat/db";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { WebSocket } from "ws";
import { getPool, closePool, upsertUserFromGithub, createSession } from "@mai-chat/db";
import { createChatServer, type CreateServerDeps } from "../src/server.js";
import type { GithubClient } from "@mai-chat/integrations";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

// Real Express app, real WebSocket server, real local Postgres -- the only
// things mocked are the GitHub/Slack API clients and the LLM call itself,
// the same "mock only the non-deterministic/external call" line every
// package in this project draws.

let aliceCookie: string;
let bobCookie: string;
const fakeGithubClient: GithubClient = {
  listIssues: async () => [],
};

function makeDeps(overrides: Partial<CreateServerDeps> = {}): CreateServerDeps {
  return {
    githubClientFactory: () => fakeGithubClient,
    slackClientFactory: () => ({ postMessage: async () => {} }),
    // Real implementations spawn/connect a subprocess or a remote MCP
    // server (see github-mcp-pool.ts / slack-mcp-pool.ts) -- these tests
    // never connect either integration, so neither is actually called,
    // but every dep here must still be present.
    githubMcpToolsFactory: async () => [],
    slackMcpToolsFactory: async () => [],
    runAgentTurn: async () => ({ reply: "Agent reply", toolCallsMade: 0 }),
    githubOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    githubOAuthDeps: { exchangeCodeForToken: async () => ({ error: "not used in this test" }), listRepositoriesForToken: async () => [] },
    slackOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    slackOAuthDeps: { exchangeCodeForToken: async () => ({ error: "not used in this test" }) },
    ...overrides,
  };
}

beforeAll(async () => {
  // This integration suite asserts the local callback URLs supplied below.
  // Keep a deployment .env (with the public DuckDNS URL) from changing the
  // app configuration while the suite runs.
  vi.stubEnv("WEB_APP_URL", "http://localhost:3000");
  vi.stubEnv("CHAT_SERVER_PUBLIC_URL", "http://localhost:4000");
  await runMigrations();
  const alice = await upsertUserFromGithub({ githubId: "test-auth-alice", username: "alice", displayName: "Alice" });
  const bob = await upsertUserFromGithub({ githubId: "test-auth-bob", username: "bob", displayName: "Bob" });
  aliceCookie = `mai_session=${(await createSession(alice.id, 60000)).token}`;
  bobCookie = `mai_session=${(await createSession(bob.id, 60000)).token}`;
});

afterAll(async () => {
  await closePool();
  vi.unstubAllEnvs();
});

// Alice creates the workspace; Bob joins it with the join code (live chat
// is members-only). conversationId is the workspace's default conversation,
// which every chat socket must name.
async function createTestWorkspace(app: ReturnType<typeof import("../src/server.js").createApp>) {
  const res = await request(app).post("/workspaces").set("Cookie", aliceCookie).send({ name: `Test Co ${Math.random()}` });
  const workspace = res.body as { id: string; joinCode: string; name: string };
  await request(app).post(`/workspaces/by-code/${workspace.joinCode}/join`).set("Cookie", bobCookie);
  const conversations = await request(app).get(`/workspaces/${workspace.id}/conversations`).set("Cookie", aliceCookie);
  return { ...workspace, conversationId: (conversations.body as Array<{ id: string }>)[0].id };
}

describe("REST routes", () => {
  it("signs up through the shared GitHub callback and permits creating and joining only until logout", async () => {
    const { app } = createChatServer(makeDeps({
      githubOAuthConfig: { clientId: "test", clientSecret: "test", redirectUri: "http://localhost:4000/auth/github/callback", webAppUrl: "http://localhost:3000" },
      userAuthDeps: {
        exchangeCodeForToken: async () => ({ accessToken: "test" }),
        fetchGithubUser: async () => ({ githubId: "integrated-auth-test", username: "member", displayName: "Member" }),
      },
    }));
    const browser = request.agent(app);
    const start = await browser.get("/auth/login/github/start").query({ returnTo: "/?workspaceName=Team" });
    const authorize = new URL(start.headers.location);
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:4000/auth/github/callback");
    const callback = await browser.get("/auth/github/callback").query({ state: authorize.searchParams.get("state"), code: "test" });
    expect(callback.headers.location).toBe("http://localhost:3000/?workspaceName=Team");
    expect((await browser.get("/auth/me")).body.displayName).toBe("Member");
    const created = await browser.post("/workspaces").send({ name: "Team" });
    expect(created.status).toBe(201);
    expect((await browser.get(`/workspaces/by-code/${created.body.joinCode}`)).status).toBe(200);
    expect((await browser.post("/auth/logout")).status).toBe(204);
    expect((await browser.get(`/workspaces/${created.body.id}`)).status).toBe(401);
  });
  it("requires a session for workspace creation, joining, history, integrations and approvals", async () => {
    const { app } = createChatServer(makeDeps());
    expect((await request(app).post("/workspaces").send({ name: "Anonymous" })).status).toBe(401);
    const workspace = await createTestWorkspace(app);
    for (const path of [`/workspaces/by-code/${workspace.joinCode}`, `/workspaces/${workspace.id}`, `/workspaces/${workspace.id}/messages`, `/workspaces/${workspace.id}/integrations`, `/workspaces/${workspace.id}/actions`]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    expect((await request(app).post(`/workspaces/${workspace.id}/actions/00000000-0000-0000-0000-000000000000/confirm`)).status).toBe(401);
    expect((await request(app).post("/workspaces").set("Cookie", aliceCookie).set("Origin", "https://evil.example").send({ name: "No" })).status).toBe(403);
  });
  it("creates a workspace and reads it back by id and by join code", async () => {
    const { app } = createChatServer(makeDeps());
    const created = await request(app).post("/workspaces").set("Cookie", aliceCookie).send({ name: "Acme" });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Acme");

    const byId = await request(app).get(`/workspaces/${created.body.id}`).set("Cookie", aliceCookie);
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe(created.body.id);

    const byCode = await request(app).get(`/workspaces/by-code/${created.body.joinCode}`).set("Cookie", aliceCookie);
    expect(byCode.status).toBe(200);
    expect(byCode.body.id).toBe(created.body.id);
  });

  it("rejects creating a workspace with no name", async () => {
    const { app } = createChatServer(makeDeps());
    const res = await request(app).post("/workspaces").set("Cookie", aliceCookie).send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown workspace id, 400 for a malformed one", async () => {
    const { app } = createChatServer(makeDeps());
    const unknown = await request(app).get("/workspaces/00000000-0000-0000-0000-000000000000").set("Cookie", aliceCookie);
    expect(unknown.status).toBe(404);
    const malformed = await request(app).get("/workspaces/not-a-uuid").set("Cookie", aliceCookie);
    expect(malformed.status).toBe(400);
  });

  it("never returns a stored token from the integrations listing", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await createTestWorkspace(app);
    const db = await import("@mai-chat/db");
    await db.upsertGithubIntegration({ workspaceId: workspace.id, owner: "octocat", repo: "hello-world", token: "ghp_secret" });
    const listed = await request(app).get(`/workspaces/${workspace.id}/integrations`).set("Cookie", aliceCookie);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain("ghp_secret");
  });
});

describe("real-time shared chat over WebSocket", () => {
  it("rejects anonymous sockets even when they claim a display name", async () => {
    const { server, app } = createChatServer(makeDeps());
    const workspace = await createTestWorkspace(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Alice`);
    expect(await new Promise<number>(resolve => socket.on("close", resolve))).toBe(4001);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  it("two members in the same workspace see each other's messages and the agent's reply live", async () => {
    const { server } = createChatServer(makeDeps({ runAgentTurn: async () => ({ reply: "Hi both of you!", toolCallsMade: 0 }) }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const app = createChatServer(makeDeps()).app;
    const workspace = await createTestWorkspace(app);

    // Use the SAME server (not a second createChatServer) for the real workspace.
    const wsUrlBase = `ws://localhost:${port}/ws`;
    const alice = new WebSocket(`${wsUrlBase}?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Alice`, { headers: { Cookie: aliceCookie } });
    const bob = new WebSocket(`${wsUrlBase}?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Bob`, { headers: { Cookie: bobCookie } });

    const aliceMessages: unknown[] = [];
    const bobMessages: unknown[] = [];
    alice.on("message", (data) => aliceMessages.push(JSON.parse(data.toString())));
    bob.on("message", (data) => bobMessages.push(JSON.parse(data.toString())));

    await Promise.all([
      new Promise((resolve) => alice.on("open", resolve)),
      new Promise((resolve) => bob.on("open", resolve)),
    ]);
    await waitFor(() => bobMessages.some((m) => (m as { type: string; participants?: unknown[] }).type === "presence" && (m as { participants?: unknown[] }).participants?.length === 2));

    alice.send(JSON.stringify({ type: "chat", content: "hello from Alice" }));

    await waitFor(() =>
      bobMessages.some((m) => (m as { type: string; message?: { content: string } }).type === "message" && m.message?.content === "hello from Alice")
    );
    await waitFor(() =>
      bobMessages.some((m) => (m as { type: string; message?: { content: string } }).type === "message" && m.message?.content === "Hi both of you!")
    );

    const aliceSawOwnMessage = aliceMessages.some(
      (m) => (m as { type: string; message?: { content: string } }).type === "message" && m.message?.content === "hello from Alice"
    );
    expect(aliceSawOwnMessage).toBe(true);

    alice.close();
    bob.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a second chat message while the agent is still working on the first, and broadcasts busy/idle status to everyone", async () => {
    let resolveAgent: (() => void) | null = null;
    const agentGate = new Promise<void>((resolve) => {
      resolveAgent = resolve;
    });
    let agentCallCount = 0;
    const { server, app } = createChatServer(
      makeDeps({
        runAgentTurn: async () => {
          agentCallCount++;
          await agentGate;
          return { reply: "Done thinking", toolCallsMade: 0 };
        },
      })
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const workspace = await createTestWorkspace(app);

    const wsUrlBase = `ws://localhost:${port}/ws`;
    const alice = new WebSocket(`${wsUrlBase}?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Alice`, { headers: { Cookie: aliceCookie } });
    const bob = new WebSocket(`${wsUrlBase}?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Bob`, { headers: { Cookie: bobCookie } });
    const aliceEvents: { type: string; status?: string; error?: string; message?: { content: string } }[] = [];
    const bobEvents: { type: string; status?: string; error?: string; message?: { content: string } }[] = [];
    alice.on("message", (data) => aliceEvents.push(JSON.parse(data.toString())));
    bob.on("message", (data) => bobEvents.push(JSON.parse(data.toString())));
    await Promise.all([
      new Promise((resolve) => alice.on("open", resolve)),
      new Promise((resolve) => bob.on("open", resolve)),
    ]);
    await waitFor(() => aliceEvents.some((m) => m.type === "presence"));

    alice.send(JSON.stringify({ type: "chat", content: "first message" }));

    // Everyone in the room -- not just the sender -- should see the room
    // go busy, since only one agent turn runs at a time per workspace.
    await waitFor(() => aliceEvents.some((m) => m.type === "agent_status" && m.status === "busy"));
    await waitFor(() => bobEvents.some((m) => m.type === "agent_status" && m.status === "busy"));

    // Bob tries to send while the agent is still working on Alice's
    // message -- this must be rejected outright, not queued.
    bob.send(JSON.stringify({ type: "chat", content: "second message, sent too soon" }));
    await waitFor(() => bobEvents.some((m) => m.type === "error" && m.error?.includes("still working")));

    resolveAgent!();

    await waitFor(() => aliceEvents.some((m) => m.type === "agent_status" && m.status === "idle"));
    await waitFor(() => bobEvents.some((m) => m.type === "agent_status" && m.status === "idle"));

    expect(agentCallCount).toBe(1);
    expect(aliceEvents.some((m) => m.type === "message" && m.message?.content === "Done thinking")).toBe(true);
    expect(aliceEvents.some((m) => m.type === "message" && m.message?.content === "second message, sent too soon")).toBe(false);

    alice.close();
    bob.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("closes the connection when workspaceId is missing or the workspace doesn't exist", async () => {
    const { server } = createChatServer(makeDeps());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const noWorkspace = new WebSocket(`ws://localhost:${port}/ws?displayName=Nobody`, { headers: { Cookie: aliceCookie } });
    const closeCode = await new Promise<number>((resolve) => noWorkspace.on("close", (code) => resolve(code)));
    expect(closeCode).toBe(4000);

    const unknownWorkspace = new WebSocket(
      `ws://localhost:${port}/ws?workspaceId=00000000-0000-0000-0000-000000000000&conversationId=00000000-0000-0000-0000-000000000000&displayName=Ghost`
    , { headers: { Cookie: aliceCookie } });
    const closeCode2 = await new Promise<number>((resolve) => unknownWorkspace.on("close", (code) => resolve(code)));
    expect(closeCode2).toBe(4004);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("broadcasts presence updates when a member disconnects", async () => {
    const { server, app } = createChatServer(makeDeps());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const workspace = await createTestWorkspace(app);

    const alice = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Alice`, { headers: { Cookie: aliceCookie } });
    await new Promise((resolve) => alice.on("open", resolve));

    const bob = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Bob`, { headers: { Cookie: bobCookie } });
    const bobMessages: { type: string; participants?: { displayName: string }[] }[] = [];
    bob.on("message", (data) => bobMessages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => bob.on("open", resolve));
    await waitFor(() => bobMessages.some((m) => m.type === "presence" && m.participants?.length === 2));

    alice.close();
    await waitFor(() =>
      bobMessages.some((m) => m.type === "presence" && m.participants?.length === 1 && m.participants[0].displayName === "Bob")
    );

    bob.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("closes a member's live socket immediately when an Admin changes their role or removes them", async () => {
    const { server, app } = createChatServer(makeDeps());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const workspace = await createTestWorkspace(app);
    const member = (await request(app).get(`/workspaces/${workspace.id}/members`).set("Cookie", aliceCookie)).body.find(
      (entry: { displayName: string }) => entry.displayName === "Bob",
    ) as { id: string };

    const openSocket = async () => {
      const socket = new WebSocket(
        `ws://localhost:${port}/ws?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}`,
        { headers: { Cookie: bobCookie } },
      );
      const ready = new Promise<void>((resolve) => {
        socket.on("message", (data) => {
          if ((JSON.parse(data.toString()) as { type?: string }).type === "history") resolve();
        });
      });
      await new Promise((resolve) => socket.on("open", resolve));
      await ready;
      return socket;
    };

    const roleSocket = await openSocket();
    const roleClosed = new Promise<number>((resolve) => roleSocket.on("close", (code) => resolve(code)));
    expect(
      (await request(app).patch(`/workspaces/${workspace.id}/members/${member.id}`).set("Cookie", aliceCookie).send({ role: "admin" }))
        .status,
    ).toBe(204);
    expect(await roleClosed).toBe(4009);

    const removedSocket = await openSocket();
    const removedClosed = new Promise<number>((resolve) => removedSocket.on("close", (code) => resolve(code)));
    expect((await request(app).delete(`/workspaces/${workspace.id}/members/${member.id}`).set("Cookie", aliceCookie)).status).toBe(204);
    expect(await removedClosed).toBe(4009);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a second connection with the same displayName replaces the first instead of appearing as a duplicate", async () => {
    const { server, app } = createChatServer(makeDeps());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const workspace = await createTestWorkspace(app);

    const first = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Alice`, { headers: { Cookie: aliceCookie } });
    const firstCloseCode = new Promise<number>((resolve) => first.on("close", (code) => resolve(code)));
    await new Promise((resolve) => first.on("open", resolve));

    const second = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}&displayName=Alice`, { headers: { Cookie: aliceCookie } });
    const secondMessages: { type: string; participants?: { displayName: string }[] }[] = [];
    second.on("message", (data) => secondMessages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => second.on("open", resolve));

    // The first connection should get evicted (closed with the app's
    // "replaced" code, not left hanging), and the room should settle on
    // exactly one Alice, not two.
    expect(await firstCloseCode).toBe(4008);
    await waitFor(() => secondMessages.some((m) => m.type === "presence" && m.participants?.length === 1));
    const finalPresence = secondMessages.filter((m) => m.type === "presence").pop();
    expect(finalPresence?.participants).toHaveLength(1);
    expect(finalPresence?.participants?.[0].displayName).toBe("Alice");

    second.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}

