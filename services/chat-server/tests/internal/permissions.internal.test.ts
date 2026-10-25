// Role access matrix: Admin-only, Editor (conditional) and shared features,
// plus the Editor permission-request flow.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, grantEditor, NIL_UUID, type TestUser } from "./helpers.js";

const app = newApp();
let admin: TestUser;
let editor: TestUser;
let outsider: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;
beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin");
  editor = await makeUser("Editor");
  outsider = await makeUser("Outsider");
  ws = await makeWorkspace(app, admin, [editor]);
});
afterAll(async () => {
  await closePool();
});

const as = (user: TestUser) => ({
  get: (path: string) => request(app).get(path).set("Cookie", user.cookie),
  post: (path: string, body?: object) =>
    request(app)
      .post(path)
      .set("Cookie", user.cookie)
      .send(body ?? {}),
  put: (path: string, body?: object) =>
    request(app)
      .put(path)
      .set("Cookie", user.cookie)
      .send(body ?? {}),
  patch: (path: string, body?: object) =>
    request(app)
      .patch(path)
      .set("Cookie", user.cookie)
      .send(body ?? {}),
  delete: (path: string) => request(app).delete(path).set("Cookie", user.cookie),
});

describe("PM-01 effective access", () => {
  it("basic: Admin holds every permission; Editor holds the default Editor policy", async () => {
    const a = await as(admin).get(`/workspaces/${ws.id}/access`);
    expect(a.body.role).toBe("admin");
    expect(Object.values(a.body.permissions).every(Boolean)).toBe(true);
    const e = await as(editor).get(`/workspaces/${ws.id}/access`);
    expect(e.body.role).toBe("editor");
    expect(e.body.permissions).toMatchObject({
      createAgents: false,
      publishAgents: false,
      manageWorkflows: false,
      manageMemory: true,
      manageArtifacts: true,
      approveActions: false,
      connectTools: true,
    });
  });
  it("security: outsiders get 403 on every shared read", async () => {
    for (const path of [
      "access",
      "members",
      "permissions",
      "tasks",
      "memory",
      "artifacts",
      "agents",
      "workflows",
      "workflow-runs",
      "integrations",
      "audit",
      "conversations",
      "observability/retention",
      "join-policy",
      "join-requests",
    ]) {
      expect((await as(outsider).get(`/workspaces/${ws.id}/${path}`)).status, path).toBe(403);
    }
  });
});

describe("PM-02 Admin-only features", () => {
  it("security: Editors are refused Admin-only endpoints", async () => {
    const checks = [
      await as(editor).put(`/workspaces/${ws.id}/permissions`, { admin: {}, editor: { createAgents: true } }),
      await as(editor).get(`/workspaces/${ws.id}/permission-requests`),
      await as(editor).get(`/workspaces/${ws.id}/invitations`),
      await as(editor).get(`/workspaces/${ws.id}/join-requests`),
      await as(editor).put(`/workspaces/${ws.id}/join-policy`, { approvalRequired: true }),
      await as(editor).post(`/workspaces/${ws.id}/invitations`, { email: "x@example.test", role: "editor" }),
      await as(editor).put(`/workspaces/${ws.id}/observability/retention`, { retentionDays: 7 }),
      await as(editor).patch(`/workspaces/${ws.id}/members/${admin.id}`, { role: "editor" }),
      await as(editor).delete(`/workspaces/${ws.id}/members/${admin.id}`),
    ];
    for (const res of checks) expect(res.status).toBe(403);
  });
  it("basic: Admin saves the Editor policy and the Editor sees it immediately", async () => {
    const current = (await as(admin).get(`/workspaces/${ws.id}/permissions`)).body;
    const saved = await as(admin).put(`/workspaces/${ws.id}/permissions`, {
      admin: current.admin,
      editor: { ...current.editor, createAgents: true },
    });
    expect(saved.status).toBe(200);
    expect((await as(editor).get(`/workspaces/${ws.id}/access`)).body.permissions.createAgents).toBe(true);
    await as(admin).put(`/workspaces/${ws.id}/permissions`, current);
  });
  it("edge: a policy body missing admin or editor is a 400; unknown keys are dropped", async () => {
    expect((await as(admin).put(`/workspaces/${ws.id}/permissions`, { editor: {} })).status).toBe(400);
    const current = (await as(admin).get(`/workspaces/${ws.id}/permissions`)).body;
    const saved = await as(admin).put(`/workspaces/${ws.id}/permissions`, {
      admin: current.admin,
      editor: { ...current.editor, superUser: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.editor).not.toHaveProperty("superUser");
  });
  it("edge: Admins cannot be stripped of their own permissions through the policy", async () => {
    const current = (await as(admin).get(`/workspaces/${ws.id}/permissions`)).body;
    await as(admin).put(`/workspaces/${ws.id}/permissions`, {
      admin: { ...current.admin, createAgents: false },
      editor: current.editor,
    });
    expect((await as(admin).get(`/workspaces/${ws.id}/access`)).body.permissions.createAgents).toBe(true);
    await as(admin).put(`/workspaces/${ws.id}/permissions`, current);
  });
});

describe("PM-03 conditional Editor features", () => {
  it("basic: createAgents gates agents and manageWorkflows gates workflows for Editors", async () => {
    const agentBody = { name: "Helper", baseAgent: "project" };
    const workflowBody = { name: "Daily", instructions: "Summarise the day", trigger: "manual" };
    expect((await as(editor).post(`/workspaces/${ws.id}/agents`, agentBody)).status).toBe(403);
    expect((await as(editor).post(`/workspaces/${ws.id}/workflows`, workflowBody)).status).toBe(403);
    await grantEditor(ws.id, { createAgents: true });
    expect((await as(editor).post(`/workspaces/${ws.id}/agents`, agentBody)).status).toBe(201);
    expect((await as(editor).post(`/workspaces/${ws.id}/workflows`, workflowBody)).status).toBe(403);
    await grantEditor(ws.id, { manageWorkflows: true });
    expect((await as(editor).post(`/workspaces/${ws.id}/workflows`, workflowBody)).status).toBe(201);
    await grantEditor(ws.id, { createAgents: false, manageWorkflows: false });
  });
  it("basic: memory and artifact management can be revoked separately", async () => {
    const memory = { title: "Release process", content: "Review before deployment." };
    const artifact = { type: "plan", status: "draft", title: "Release plan", content: "## Review" };
    expect((await as(editor).post(`/workspaces/${ws.id}/memory`, memory)).status).toBe(201);
    expect((await as(editor).post(`/workspaces/${ws.id}/artifacts`, artifact)).status).toBe(201);
    await grantEditor(ws.id, { manageMemory: false, manageArtifacts: false });
    expect((await as(editor).post(`/workspaces/${ws.id}/memory`, memory)).status).toBe(403);
    expect((await as(editor).post(`/workspaces/${ws.id}/artifacts`, artifact)).status).toBe(403);
    await grantEditor(ws.id, { manageMemory: true, manageArtifacts: true });
  });
  it("basic: publishAgents gates publishing separately from building", async () => {
    await grantEditor(ws.id, { createAgents: true, publishAgents: false });
    const agent = await as(editor).post(`/workspaces/${ws.id}/agents`, {
      name: "Publisher test",
      baseAgent: "project",
      instructions: "Review the workspace and publish a concise status update.",
    });
    expect((await as(editor).post(`/workspaces/${ws.id}/agents/${agent.body.id}/publish`)).status).toBe(403);
    await grantEditor(ws.id, { publishAgents: true });
    expect((await as(editor).post(`/workspaces/${ws.id}/agents/${agent.body.id}/publish`)).status).toBe(200);
    await grantEditor(ws.id, { createAgents: false, publishAgents: false });
  });
  it("basic: connectTools gates the connect capability check", async () => {
    expect((await as(editor).get(`/workspaces/${ws.id}/capabilities/connect-tools`)).status).toBe(204);
    await grantEditor(ws.id, { connectTools: false });
    expect((await as(editor).get(`/workspaces/${ws.id}/capabilities/connect-tools`)).status).toBe(403);
    expect((await as(admin).get(`/workspaces/${ws.id}/capabilities/connect-tools`)).status).toBe(204);
    await grantEditor(ws.id, { connectTools: true });
  });
});

describe("PM-04 permission requests", () => {
  it("basic: Editor asks, Admin approves, Editor gains the permission and is notified", async () => {
    const asked = await as(editor).post(`/workspaces/${ws.id}/permission-requests`, {
      permission: "approveActions",
      reason: "I review deploys",
    });
    expect(asked.status).toBe(201);
    const pending = await as(admin).get(`/workspaces/${ws.id}/permission-requests`);
    expect(pending.body.some((r: { id: string }) => r.id === asked.body.id)).toBe(true);
    expect((await as(admin).post(`/workspaces/${ws.id}/permission-requests/${asked.body.id}/approve`)).status).toBe(
      204,
    );
    expect((await as(editor).get(`/workspaces/${ws.id}/access`)).body.permissions.approveActions).toBe(true);
    const notes = await as(editor).get(`/notifications?workspaceId=${ws.id}`);
    expect(JSON.stringify(notes.body)).toMatch(/approved your request for approveActions/);
    await grantEditor(ws.id, { approveActions: false });
  });
  it("basic: Admin rejects; the permission stays off and the request cannot be decided twice", async () => {
    const asked = await as(editor).post(`/workspaces/${ws.id}/permission-requests`, {
      permission: "publishAgents",
      reason: "Ship my agent",
    });
    expect((await as(admin).post(`/workspaces/${ws.id}/permission-requests/${asked.body.id}/reject`)).status).toBe(204);
    expect((await as(editor).get(`/workspaces/${ws.id}/access`)).body.permissions.publishAgents).toBe(false);
    expect((await as(admin).post(`/workspaces/${ws.id}/permission-requests/${asked.body.id}/approve`)).status).toBe(
      404,
    );
  });
  it("edge: invalid permission, missing/oversized reason, already-held permission", async () => {
    expect(
      (await as(editor).post(`/workspaces/${ws.id}/permission-requests`, { permission: "root", reason: "x" })).status,
    ).toBe(400);
    expect(
      (await as(editor).post(`/workspaces/${ws.id}/permission-requests`, { permission: "createAgents", reason: "   " }))
        .status,
    ).toBe(400);
    expect(
      (
        await as(editor).post(`/workspaces/${ws.id}/permission-requests`, {
          permission: "createAgents",
          reason: "x".repeat(1001),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(editor).post(`/workspaces/${ws.id}/permission-requests`, {
          permission: "connectTools",
          reason: "Already have it",
        })
      ).status,
    ).toBe(409);
  });
  it("edge: a second request for the same pending permission is a 409", async () => {
    expect(
      (
        await as(editor).post(`/workspaces/${ws.id}/permission-requests`, {
          permission: "createAgents",
          reason: "First ask",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await as(editor).post(`/workspaces/${ws.id}/permission-requests`, {
          permission: "createAgents",
          reason: "Second ask",
        })
      ).status,
    ).toBe(409);
  });
  it("edge: unknown decision, unknown request and malformed request id are 404s", async () => {
    expect((await as(admin).post(`/workspaces/${ws.id}/permission-requests/${NIL_UUID}/maybe`)).status).toBe(404);
    expect((await as(admin).post(`/workspaces/${ws.id}/permission-requests/${NIL_UUID}/approve`)).status).toBe(404);
    expect((await as(admin).post(`/workspaces/${ws.id}/permission-requests/not-a-uuid/approve`)).status).toBe(404);
  });
  it("security: Admins cannot file requests and Editors cannot decide them", async () => {
    expect(
      (await as(admin).post(`/workspaces/${ws.id}/permission-requests`, { permission: "createAgents", reason: "x" }))
        .status,
    ).toBe(403);
    expect((await as(editor).post(`/workspaces/${ws.id}/permission-requests/${NIL_UUID}/approve`)).status).toBe(403);
  });
});
