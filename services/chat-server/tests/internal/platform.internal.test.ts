// Notifications, per-member preferences, integrations, health and hostile input.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { apiSecurityHeaders } from "../../src/server.js";
import * as db from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, grantEditor, NIL_UUID, type TestUser } from "./helpers.js";

const app = newApp();
let admin: TestUser; let editor: TestUser; let outsider: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;
beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin"); editor = await makeUser("Editor"); outsider = await makeUser("Outsider");
  ws = await makeWorkspace(app, admin, [editor]);
});
afterAll(async () => { await db.closePool(); });

describe("NT-01 notifications", () => {
  it("basic: lists a member's notifications and marks them read", async () => {
    await db.notifyWorkspaceUser({ workspaceId: ws.id, userId: editor.id, kind: "permission_request", text: "Probe one" });
    await db.notifyWorkspaceUser({ workspaceId: ws.id, userId: editor.id, kind: "permission_request", text: "Probe two" });
    const list = await request(app).get(`/notifications?workspaceId=${ws.id}`).set("Cookie", editor.cookie);
    expect(list.status).toBe(200);
    const probes = list.body.filter((n: { text: string }) => n.text.startsWith("Probe"));
    expect(probes).toHaveLength(2);
    expect((await request(app).post("/notifications/read").set("Cookie", editor.cookie).send({ workspaceId: ws.id, ids: [probes[0].id] })).status).toBe(204);
    const after = (await request(app).get(`/notifications?workspaceId=${ws.id}`).set("Cookie", editor.cookie)).body;
    expect(after.find((n: { id: string }) => n.id === probes[0].id).readAt).toBeTruthy();
    expect(after.find((n: { id: string }) => n.id === probes[1].id).readAt).toBeFalsy();
    await request(app).post("/notifications/read").set("Cookie", editor.cookie).send({ workspaceId: ws.id });
    const all = (await request(app).get(`/notifications?workspaceId=${ws.id}`).set("Cookie", editor.cookie)).body;
    expect(all.every((n: { readAt: string | null }) => n.readAt)).toBe(true);
  });
  it("edge: notifications are private to their recipient", async () => {
    const adminList = (await request(app).get(`/notifications?workspaceId=${ws.id}`).set("Cookie", admin.cookie)).body;
    expect(adminList.some((n: { text: string }) => n.text.startsWith("Probe"))).toBe(false);
  });
  it("edge: bad limit/before/workspaceId values never cause a server error", async () => {
    for (const q of ["?limit=abc", "?limit=0", "?limit=2.5", "?limit=99999", "?before=nope", "?workspaceId=nope"]) {
      expect((await request(app).get(`/notifications${q}`).set("Cookie", editor.cookie)).status, q).toBe(200);
    }
    expect((await request(app).post("/notifications/read").set("Cookie", editor.cookie).send({ workspaceId: "nope" })).status).toBe(400);
  });
  it("security: signed-out requests are 401; non-members cannot read a workspace's notifications", async () => {
    expect((await request(app).get("/notifications")).status).toBe(401);
    expect((await request(app).get(`/notifications?workspaceId=${ws.id}`).set("Cookie", outsider.cookie)).status).toBe(403);
    expect((await request(app).post("/notifications/read").set("Cookie", outsider.cookie).send({ workspaceId: ws.id })).status).toBe(403);
  });
});

describe("NT-02 notification preferences", () => {
  const url = "/notifications/preferences";
  it("basic: reads defaults and saves valid changes", async () => {
    const defaults = await request(app).get(`${url}?workspaceId=${ws.id}`).set("Cookie", editor.cookie);
    expect(defaults.status).toBe(200);
    const saved = await request(app).put(url).set("Cookie", editor.cookie).send({ workspaceId: ws.id, escalationMinutes: 60, quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, digestHour: 9, dailySummaryEnabled: true });
    expect(saved.body).toMatchObject({ escalationMinutes: 60, quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, digestHour: 9, dailySummaryEnabled: true });
  });
  it("edge: invalid values are ignored and the saved values are kept", async () => {
    const saved = await request(app).put(url).set("Cookie", editor.cookie).send({ workspaceId: ws.id, escalationMinutes: 7, quietHoursStart: 24, quietHoursEnd: -1, digestHour: 3.5, browserEnabled: "maybe", dailySummaryEnabled: "yes" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ escalationMinutes: 60, quietHoursStart: 22, quietHoursEnd: 7, digestHour: 9, dailySummaryEnabled: true });
    expect(typeof saved.body.browserEnabled).toBe("boolean");
  });
  it("edge: preferences are per member", async () => {
    await request(app).put(url).set("Cookie", admin.cookie).send({ workspaceId: ws.id, escalationMinutes: 15 });
    expect((await request(app).get(`${url}?workspaceId=${ws.id}`).set("Cookie", editor.cookie)).body.escalationMinutes).toBe(60);
    expect((await request(app).get(`${url}?workspaceId=${ws.id}`).set("Cookie", admin.cookie)).body.escalationMinutes).toBe(15);
  });
  it("security: missing workspace is 400; non-members are refused", async () => {
    expect((await request(app).get(url).set("Cookie", editor.cookie)).status).toBe(400);
    expect((await request(app).get(`${url}?workspaceId=${ws.id}`).set("Cookie", outsider.cookie)).status).toBe(403);
    expect((await request(app).put(url).set("Cookie", outsider.cookie).send({ workspaceId: ws.id, digestHour: 1 })).status).toBe(403);
  });
});

describe("PF-01 member preferences (favourites, saved views)", () => {
  const url = (key: string) => `/workspaces/${ws.id}/preferences/${key}`;
  it("basic: saves and reads back each supported key", async () => {
    for (const key of ["agent-favorites", "activity-views", "notifications-cleared-at"]) {
      expect((await request(app).put(url(key)).set("Cookie", editor.cookie).send({ value: [key, 1] })).status).toBe(204);
      expect((await request(app).get(url(key)).set("Cookie", editor.cookie)).body.value).toEqual([key, 1]);
    }
  });
  it("edge: unknown key 404; missing or >20 KB value 400; falsy values are allowed", async () => {
    expect((await request(app).get(url("theme")).set("Cookie", editor.cookie)).status).toBe(404);
    expect((await request(app).put(url("agent-favorites")).set("Cookie", editor.cookie).send({})).status).toBe(400);
    expect((await request(app).put(url("agent-favorites")).set("Cookie", editor.cookie).send({ value: "x".repeat(20_001) })).status).toBe(400);
    for (const value of [0, false, "", null]) {
      expect((await request(app).put(url("agent-favorites")).set("Cookie", editor.cookie).send({ value })).status).toBe(204);
    }
  });
  it("security: values are private to each member; outsiders are refused", async () => {
    await request(app).put(url("activity-views")).set("Cookie", editor.cookie).send({ value: ["mine"] });
    expect((await request(app).get(url("activity-views")).set("Cookie", admin.cookie)).body.value).not.toEqual(["mine"]);
    expect((await request(app).get(url("activity-views")).set("Cookie", outsider.cookie)).status).toBe(403);
  });
});

describe("IN-01 integrations", () => {
  it("basic: members list connections (empty for a new workspace)", async () => {
    const res = await request(app).get(`/workspaces/${ws.id}/integrations`).set("Cookie", editor.cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
  it("basic: each member keeps a separate account for every provider", async () => {
    // Connections are created by each provider's OAuth callback; seed them directly.
    for (const member of [admin, editor]) {
      const github = await db.upsertGithubIntegration({ workspaceId: ws.id, owner: member.displayName.toLowerCase(), repo: "project", token: `github-token-${member.id}`, connectionName: "My GitHub", connectionScope: "personal", ownerUserId: member.id });
      expect(github).toMatchObject({ type: "github", ownerUserId: member.id, connectionScope: "personal" });
      await db.upsertSlackIntegration({ workspaceId: ws.id, teamName: `${member.displayName}'s Slack`, token: `slack-token-${member.id}`, ownerUserId: member.id });
      for (const provider of ["linear", "notion", "figma"] as const) {
        const remote = await db.upsertRemoteMcpIntegration({ workspaceId: ws.id, type: provider, endpoint: `https://${provider}.example.test/mcp`, token: `${provider}-token-${member.id}`, ownerUserId: member.id });
        expect(remote).toMatchObject({ type: provider, ownerUserId: member.id, connectionScope: "personal" });
      }
    }
    const connections = (await request(app).get(`/workspaces/${ws.id}/integrations`).set("Cookie", admin.cookie)).body;
    expect(connections).toHaveLength(10);
    expect(JSON.stringify(connections)).not.toContain("-token-");
    for (const provider of ["github", "slack", "linear", "notion", "figma"]) {
      const accounts = connections.filter((connection: { type: string }) => connection.type === provider);
      expect(accounts).toHaveLength(2);
      expect(accounts.map((connection: { ownerUserId: string }) => connection.ownerUserId).sort()).toEqual([admin.id, editor.id].sort());
    }
  });
  it("security: there is no pasted-token connection route for any provider", async () => {
    const before = (await request(app).get(`/workspaces/${ws.id}/integrations`).set("Cookie", admin.cookie)).body.length;
    expect((await request(app).post(`/workspaces/${ws.id}/integrations/github`).set("Cookie", admin.cookie).send({ owner: "o", repo: "r", token: "ghp_pasted" })).status).toBe(404);
    for (const provider of ["linear", "notion", "figma"]) {
      expect((await request(app).post(`/workspaces/${ws.id}/integrations/${provider}/mcp`).set("Cookie", admin.cookie).send({ endpoint: "https://mcp.example.test", token: "pasted" })).status).toBe(404);
    }
    expect((await request(app).get(`/workspaces/${ws.id}/integrations`).set("Cookie", admin.cookie)).body).toHaveLength(before);
  });
  it("basic/edge: a member saves the Figma team their own connection may browse, checked with Figma first", async () => {
    const outsiderToTeam = newApp({ figmaTeamLoader: async () => { throw new Error("Figma refused access: Invalid scope."); } });
    const teamApp = newApp({ figmaTeamLoader: async (_token, teamId) => ({ teamName: teamId === "1234567890" ? "Hena's team" : undefined }) });
    // Editor has no Figma connection of their own in this workspace yet.
    await db.getPool().query(`DELETE FROM integrations WHERE workspace_id = $1 AND type = 'figma' AND owner_user_id = $2`, [ws.id, editor.id]);
    expect((await request(teamApp).post(`/workspaces/${ws.id}/integrations/figma/team`).set("Cookie", editor.cookie).send({ team: "1234567890" })).status).toBe(409);
    expect((await request(teamApp).post(`/workspaces/${ws.id}/integrations/figma/team`).set("Cookie", admin.cookie).send({ team: "not a team" })).status).toBe(400);
    const refused = await request(outsiderToTeam).post(`/workspaces/${ws.id}/integrations/figma/team`).set("Cookie", admin.cookie).send({ team: "1234567890" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/"folders:read" scope/);
    const saved = await request(teamApp).post(`/workspaces/${ws.id}/integrations/figma/team`).set("Cookie", admin.cookie).send({ team: "https://www.figma.com/files/team/1234567890/all-projects" });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ teamId: "1234567890", teamName: "Hena's team" });
    const listing = (await request(app).get(`/workspaces/${ws.id}/integrations`).set("Cookie", admin.cookie)).body;
    expect(listing.find((item: { type: string; ownerUserId: string }) => item.type === "figma" && item.ownerUserId === admin.id)).toMatchObject({ teamId: "1234567890", teamName: "Hena's team" });
    const credential = await db.getIntegrationCredential(ws.id, "figma", listing.find((item: { type: string; ownerUserId: string; id: string }) => item.type === "figma" && item.ownerUserId === admin.id).id);
    expect(credential?.repo?.split(":")[0]).toBe("1234567890");
  });
  it("edge: testing an unknown connection is a 404", async () => {
    for (const key of ["github", "nope", NIL_UUID]) {
      expect((await request(app).post(`/workspaces/${ws.id}/integrations/${key}/test`).set("Cookie", admin.cookie)).status).toBe(404);
    }
  });
  it("edge: disconnect validates provider and integration id", async () => {
    expect((await request(app).delete(`/workspaces/${ws.id}/integrations/myspace?integrationId=${NIL_UUID}`).set("Cookie", admin.cookie)).status).toBe(404);
    expect((await request(app).delete(`/workspaces/${ws.id}/integrations/github?integrationId=nope`).set("Cookie", admin.cookie)).status).toBe(400);
    expect((await request(app).delete(`/workspaces/${ws.id}/integrations/github?integrationId=${NIL_UUID}`).set("Cookie", admin.cookie)).status).toBe(404);
  });
  it("security: Editors without connectTools cannot disconnect; outsiders cannot list", async () => {
    await grantEditor(ws.id, { connectTools: false });
    expect((await request(app).delete(`/workspaces/${ws.id}/integrations/github?integrationId=${NIL_UUID}`).set("Cookie", editor.cookie)).status).toBe(403);
    await grantEditor(ws.id, { connectTools: true });
    expect((await request(app).get(`/workspaces/${ws.id}/integrations`).set("Cookie", outsider.cookie)).status).toBe(403);
  });
});

describe("SY-00 browser security headers (scope 12)", () => {
  it("basic: every API response forbids framing, sniffing, scripts and referrers", async () => {
    for (const res of [
      await request(app).get("/healthz"),
      await request(app).get("/public/dashboards/00000000-0000-4000-8000-000000000000"),
      await request(app).get("/workspaces").set("Cookie", admin.cookie),
    ]) {
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    }
  });
  it("edge: an unknown route still answers with no-script, no-framing headers", async () => {
    // Express's own 404 page narrows the CSP to default-src 'none'.
    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.headers["content-security-policy"]).toMatch(/^default-src 'none'/);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
  it("edge: HSTS is only sent by production servers", async () => {
    expect((await request(app).get("/healthz")).headers["strict-transport-security"]).toBeUndefined();
    const prod = express();
    prod.use(apiSecurityHeaders({ hsts: true }));
    prod.get("/", (_req, res) => res.json({ ok: true }));
    expect((await request(prod).get("/")).headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });
  it("edge: CORS preflight from the web app still succeeds with the headers in place", async () => {
    const res = await request(app).options("/workspaces").set("Origin", process.env.WEB_APP_URL ?? "http://localhost:3000").set("Access-Control-Request-Method", "POST");
    expect(res.status).toBeLessThan(300);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

describe("SY-01 health and hostile input", () => {
  it("basic: health and readiness probes answer", async () => {
    expect((await request(app).get("/healthz")).body.ok).toBe(true);
    expect((await request(app).get("/readyz")).status).toBe(200);
  });
  it("edge: malformed JSON is a 4xx, never a 500", async () => {
    const res = await request(app).post("/workspaces").set("Cookie", admin.cookie).set("content-type", "application/json").send("{bad json");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
  it("edge: wrong JSON shapes (arrays, numbers, null) are rejected cleanly", async () => {
    for (const body of [[], [1, 2], { name: null }, { name: 123 }, { name: { $ne: "" } }]) {
      const res = await request(app).post("/workspaces").set("Cookie", admin.cookie).send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
  it("edge: every nested entity route answers 404 for malformed ids", async () => {
    const paths = [
      ["patch", `tasks/x`], ["delete", `memory/x`], ["patch", `artifacts/x`], ["get", `artifacts/x/comments`], ["post", `artifacts/x/presence`],
      ["patch", `agents/x`], ["get", `workflows/x/runs`], ["patch", `conversations/x`], ["patch", `members/x`], ["delete", `invitations/x`],
    ] as const;
    for (const [method, path] of paths) {
      const res = await request(app)[method](`/workspaces/${ws.id}/${path}`).set("Cookie", admin.cookie).send({});
      expect([400, 404], `${method} ${path} -> ${res.status}`).toContain(res.status);
    }
  });
  it("security: an unknown session cookie is treated as signed out", async () => {
    expect((await request(app).get("/workspaces").set("Cookie", "mai_session=forged-token")).status).toBe(401);
  });
});
