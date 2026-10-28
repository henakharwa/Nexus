// Role access matrix: Admin-only, Editor (conditional) and shared features,
// plus the Editor permission-request flow.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool, setWorkspaceMemberPermissionGrant } from "@mai-chat/db";
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
  it("basic: the table-driven role matrix gives Admins every capability and Editors only the configured baseline", async () => {
    const editorBaseline = {
      connectTools: true,
      createAgents: false,
      publishAgents: false,
      manageWorkflows: false,
      manageMemory: true,
      manageArtifacts: true,
      approveActions: false,
      github: true,
      slack: true,
      linear: true,
      notion: true,
      figma: true,
    };
    const a = await as(admin).get(`/workspaces/${ws.id}/access`);
    expect(a.body.role).toBe("admin");
    const e = await as(editor).get(`/workspaces/${ws.id}/access`);
    expect(e.body.role).toBe("editor");
    for (const [permission, editorAllowed] of Object.entries(editorBaseline)) {
      expect(a.body.permissions[permission], `Admin ${permission}`).toBe(true);
      expect(e.body.permissions[permission], `Editor ${permission}`).toBe(editorAllowed);
    }
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
    // With the permission an Editor's memory change is accepted for Admin review (202).
    expect((await as(editor).post(`/workspaces/${ws.id}/memory`, memory)).status).toBe(202);
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
  it("basic: Admin approval grants only the requesting Editor and not every Editor", async () => {
    const otherEditor = await makeUser("Other Editor");
    expect((await as(otherEditor).post(`/workspaces/by-code/${ws.joinCode}/join`)).status).toBe(200);
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
    expect((await as(otherEditor).get(`/workspaces/${ws.id}/access`)).body.permissions.approveActions).toBe(false);
    expect(
      (await as(admin).get(`/workspaces/${ws.id}/members/${editor.id}/permission-grants`)).body.permissions,
    ).toContain("approveActions");
    expect(
      (
        await as(admin).put(`/workspaces/${ws.id}/members/${otherEditor.id}/permission-grants/createAgents`, {
          granted: true,
        })
      ).status,
    ).toBe(204);
    expect((await as(otherEditor).get(`/workspaces/${ws.id}/access`)).body.permissions.createAgents).toBe(true);
    expect(
      (
        await as(admin).put(`/workspaces/${ws.id}/members/${otherEditor.id}/permission-grants/createAgents`, {
          granted: false,
        })
      ).status,
    ).toBe(204);
    expect((await as(otherEditor).get(`/workspaces/${ws.id}/access`)).body.permissions.createAgents).toBe(false);
    const notes = await as(editor).get(`/notifications?workspaceId=${ws.id}`);
    expect(JSON.stringify(notes.body)).toMatch(/granted you approveActions/);
    await setWorkspaceMemberPermissionGrant(ws.id, editor.id, "approveActions", false);
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

describe("PM-05 ownership boundaries", () => {
  it("security: an Editor with the capability can edit their own agent and workflow, but not a teammate's; an Admin can manage both", async () => {
    const peer = await makeUser("Peer Editor");
    expect((await as(peer).post(`/workspaces/by-code/${ws.joinCode}/join`)).status).toBe(200);
    for (const userId of [editor.id, peer.id]) {
      await setWorkspaceMemberPermissionGrant(ws.id, userId, "createAgents", true);
      await setWorkspaceMemberPermissionGrant(ws.id, userId, "manageWorkflows", true);
    }

    const agent = await as(editor).post(`/workspaces/${ws.id}/agents`, {
      name: "Owner-only agent",
      baseAgent: "project",
      instructions: "Keep the release notes accurate.",
    });
    expect(agent.status).toBe(201);
    expect((await as(peer).patch(`/workspaces/${ws.id}/agents/${agent.body.id}`, { name: "Hijacked" })).status).toBe(
      403,
    );
    expect((await as(peer).delete(`/workspaces/${ws.id}/agents/${agent.body.id}`)).status).toBe(403);
    expect(
      (await as(editor).patch(`/workspaces/${ws.id}/agents/${agent.body.id}`, { name: "Editor-owned agent" })).status,
    ).toBe(200);
    expect(
      (await as(admin).patch(`/workspaces/${ws.id}/agents/${agent.body.id}`, { name: "Admin-managed agent" })).status,
    ).toBe(200);

    const workflowBody = {
      name: "Owner-only workflow",
      instructions: "Summarize the release status.",
      trigger: "manual",
    };
    const workflow = await as(editor).post(`/workspaces/${ws.id}/workflows`, workflowBody);
    expect(workflow.status).toBe(201);
    expect((await as(peer).patch(`/workspaces/${ws.id}/workflows/${workflow.body.id}`, workflowBody)).status).toBe(403);
    expect((await as(peer).delete(`/workspaces/${ws.id}/workflows/${workflow.body.id}`)).status).toBe(403);
    expect(
      (
        await as(editor).patch(`/workspaces/${ws.id}/workflows/${workflow.body.id}`, {
          ...workflowBody,
          name: "Editor-owned workflow",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await as(admin).patch(`/workspaces/${ws.id}/workflows/${workflow.body.id}`, {
          ...workflowBody,
          name: "Admin-managed workflow",
        })
      ).status,
    ).toBe(200);
  });
});
