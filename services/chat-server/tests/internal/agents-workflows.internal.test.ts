// Agent builder, publishing, versions, workflows, runs and observability settings.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, grantEditor, NIL_UUID, type TestUser } from "./helpers.js";

const app = newApp();
let admin: TestUser; let editor: TestUser; let outsider: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;
beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin"); editor = await makeUser("Editor"); outsider = await makeUser("Outsider");
  ws = await makeWorkspace(app, admin, [editor]);
});
afterAll(async () => { await closePool(); });

const agents = () => `/workspaces/${ws.id}/agents`;
const workflows = () => `/workspaces/${ws.id}/workflows`;
const waitFor = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

describe("AG-01 agent builder", () => {
  it("basic: Admin creates a draft agent with providers and model", async () => {
    const res = await request(app).post(agents()).set("Cookie", admin.cookie).send({ name: "  Release bot ", baseAgent: "github", instructions: "Be brief", approvedProviders: ["github", "slack", "evil"], model: "workspace-default" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Release bot", status: "draft", approvedProviders: ["github", "slack"] });
  });
  it("edge: blank, whitespace or over-long names and unknown base agents are 400", async () => {
    for (const body of [{ baseAgent: "project" }, { name: "", baseAgent: "project" }, { name: "   ", baseAgent: "project" }, { name: "n".repeat(81), baseAgent: "project" }, { name: "Ok", baseAgent: "skynet" }]) {
      expect((await request(app).post(agents()).set("Cookie", admin.cookie).send(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });
  it("edge: rename to blank is refused; partial updates keep other fields", async () => {
    const agent = (await request(app).post(agents()).set("Cookie", admin.cookie).send({ name: "Keeper", baseAgent: "project", instructions: "keep me" })).body;
    expect((await request(app).patch(`${agents()}/${agent.id}`).set("Cookie", admin.cookie).send({ name: "  " })).status).toBe(400);
    const updated = await request(app).patch(`${agents()}/${agent.id}`).set("Cookie", admin.cookie).send({ knowledge: "facts" });
    expect(updated.body).toMatchObject({ name: "Keeper", instructions: "keep me", knowledge: "facts" });
  });
  it("basic: publishing creates numbered versions", async () => {
    const agent = (await request(app).post(agents()).set("Cookie", admin.cookie).send({ name: "Versioned", baseAgent: "project", instructions: "v1" })).body;
    expect((await request(app).post(`${agents()}/${agent.id}/publish`).set("Cookie", admin.cookie)).body).toMatchObject({ status: "published", publishedVersion: 1 });
    await request(app).patch(`${agents()}/${agent.id}`).set("Cookie", admin.cookie).send({ instructions: "v2" });
    expect((await request(app).post(`${agents()}/${agent.id}/publish`).set("Cookie", admin.cookie)).body.publishedVersion).toBe(2);
    const versions = (await request(app).get(`${agents()}/${agent.id}/versions`).set("Cookie", editor.cookie)).body;
    expect(versions.map((v: { version: number }) => v.version).sort()).toEqual([1, 2]);
  });
  it("requires instructions before publishing a draft agent", async () => {
    const agent = (await request(app).post(agents()).set("Cookie", admin.cookie).send({ name: "Needs behavior", baseAgent: "project" })).body;
    const published = await request(app).post(`${agents()}/${agent.id}/publish`).set("Cookie", admin.cookie);
    expect(published.status).toBe(400);
    expect(published.body.error).toMatch(/Instructions are required/);
  });
  it("edge: unknown and malformed agent ids are 404", async () => {
    expect((await request(app).patch(`${agents()}/${NIL_UUID}`).set("Cookie", admin.cookie).send({ name: "x" })).status).toBe(404);
    expect((await request(app).post(`${agents()}/bad/publish`).set("Cookie", admin.cookie)).status).toBe(404);
    expect((await request(app).delete(`${agents()}/bad`).set("Cookie", admin.cookie)).status).toBe(404);
    expect((await request(app).get(`${agents()}/bad/versions`).set("Cookie", admin.cookie)).status).toBe(404);
  });
  it("security: Editors can view agents and models, but not build without createAgents", async () => {
    expect((await request(app).get(agents()).set("Cookie", editor.cookie)).status).toBe(200);
    expect((await request(app).get(`/workspaces/${ws.id}/agent-models`).set("Cookie", editor.cookie)).body).toContain("workspace-default");
    const agent = (await request(app).post(agents()).set("Cookie", admin.cookie).send({ name: "Locked", baseAgent: "project" })).body;
    expect((await request(app).patch(`${agents()}/${agent.id}`).set("Cookie", editor.cookie).send({ name: "x" })).status).toBe(403);
    expect((await request(app).delete(`${agents()}/${agent.id}`).set("Cookie", editor.cookie)).status).toBe(403);
    expect((await request(app).get(agents()).set("Cookie", outsider.cookie)).status).toBe(403);
  });
  it("basic: delete removes the agent", async () => {
    const agent = (await request(app).post(agents()).set("Cookie", admin.cookie).send({ name: "Temp", baseAgent: "project" })).body;
    expect((await request(app).delete(`${agents()}/${agent.id}`).set("Cookie", admin.cookie)).status).toBe(204);
    expect((await request(app).delete(`${agents()}/${agent.id}`).set("Cookie", admin.cookie)).status).toBe(404);
  });
});

describe("WF-01 workflows", () => {
  it("basic: creates manual and scheduled workflows", async () => {
    const manual = await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "Standup", instructions: "Summarise" });
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ trigger: "manual", enabled: true });
    const scheduled = await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "Hourly", instructions: "Check", trigger: "schedule", scheduleMinutes: 60 });
    expect(scheduled.body.scheduleMinutes).toBe(60);
  });
  it("edge: schedule interval bounds are 5 to 10080 whole minutes", async () => {
    for (const scheduleMinutes of [4, 10081, 7.5, "sixty", undefined]) {
      expect((await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "S", instructions: "i", trigger: "schedule", scheduleMinutes })).status, String(scheduleMinutes)).toBe(400);
    }
    for (const scheduleMinutes of [5, 10080]) {
      expect((await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "S", instructions: "i", trigger: "schedule", scheduleMinutes })).status).toBe(201);
    }
  });
  it("edge: name and instructions are required; names are capped; agent must be published", async () => {
    expect((await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: " ", instructions: "i" })).status).toBe(400);
    expect((await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "n", instructions: " " })).status).toBe(400);
    expect((await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "n".repeat(121), instructions: "i" })).status).toBe(400);
    const draft = (await request(app).post(agents()).set("Cookie", admin.cookie).send({ name: "Draft only", baseAgent: "project" })).body;
    expect((await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "n", instructions: "i", workspaceAgentId: draft.id })).status).toBe(400);
  });
  it("edge: requiresApproval is saved and kept when an update omits it", async () => {
    const wf = (await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "Careful", instructions: "i", requiresApproval: true })).body;
    expect(wf.requiresApproval).toBe(true);
    const updated = await request(app).patch(`${workflows()}/${wf.id}`).set("Cookie", admin.cookie).send({ name: "Careful 2", instructions: "i" });
    expect(updated.body).toMatchObject({ name: "Careful 2", requiresApproval: true });
  });
  it("basic: a manual run is accepted and recorded in run history", async () => {
    const wf = (await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "Runner", instructions: "Say hi" })).body;
    expect((await request(app).post(`${workflows()}/${wf.id}/run`).set("Cookie", admin.cookie).send({})).status).toBe(202);
    const recorded = await waitFor(async () => (await request(app).get(`${workflows()}/${wf.id}/runs`).set("Cookie", editor.cookie)).body.length > 0);
    expect(recorded).toBe(true);
    const all = await request(app).get(`/workspaces/${ws.id}/workflow-runs`).set("Cookie", editor.cookie);
    expect(all.body.some((r: { workflowName: string }) => r.workflowName === "Runner")).toBe(true);
  });
  it("edge: an event that does not match the trigger is refused", async () => {
    const wf = (await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "Manual only", instructions: "i" })).body;
    expect((await request(app).post(`${workflows()}/${wf.id}/run`).set("Cookie", admin.cookie).send({ trigger: "slack_mention" })).status).toBe(400);
  });
  it("security: manual runs reject caller-supplied event data", async () => {
    const wf = (await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "Verified events only", instructions: "i" })).body;
    const response = await request(app).post(`${workflows()}/${wf.id}/run`).set("Cookie", admin.cookie).send({ eventText: "pretend this came from GitHub" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/verified provider webhooks/i);
  });
  it("edge: run history pagination ignores bad limit/before values", async () => {
    for (const q of ["?limit=abc", "?limit=-1", "?limit=1.5", "?limit=100000", "?before=garbage"]) {
      expect((await request(app).get(`/workspaces/${ws.id}/workflow-runs${q}`).set("Cookie", admin.cookie)).status, q).toBe(200);
    }
  });
  it("edge: unknown and malformed workflow ids are 404", async () => {
    expect((await request(app).post(`${workflows()}/${NIL_UUID}/run`).set("Cookie", admin.cookie)).status).toBe(404);
    expect((await request(app).get(`${workflows()}/bad/runs`).set("Cookie", admin.cookie)).status).toBe(404);
    expect((await request(app).delete(`${workflows()}/bad`).set("Cookie", admin.cookie)).status).toBe(404);
  });
  it("security: Editors need manageWorkflows to change or run workflows", async () => {
    const wf = (await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "Guarded", instructions: "i" })).body;
    expect((await request(app).get(workflows()).set("Cookie", editor.cookie)).status).toBe(200);
    expect((await request(app).post(`${workflows()}/${wf.id}/run`).set("Cookie", editor.cookie)).status).toBe(403);
    expect((await request(app).patch(`${workflows()}/${wf.id}`).set("Cookie", editor.cookie).send({ name: "x", instructions: "y" })).status).toBe(403);
    await grantEditor(ws.id, { manageWorkflows: true });
    expect((await request(app).post(`${workflows()}/${wf.id}/run`).set("Cookie", editor.cookie)).status).toBe(202);
    await grantEditor(ws.id, { manageWorkflows: false });
  });
  it("security: only Admins can take over a workflow", async () => {
    const wf = (await request(app).post(workflows()).set("Cookie", admin.cookie).send({ name: "Admin owned", instructions: "i" })).body;
    await grantEditor(ws.id, { manageWorkflows: true });
    expect((await request(app).post(`/workspaces/${ws.id}/workflows/${wf.id}/take-over`).set("Cookie", editor.cookie)).status).toBe(403);
    const taken = await request(app).post(`/workspaces/${ws.id}/workflows/${wf.id}/take-over`).set("Cookie", admin.cookie);
    expect(taken.status).toBe(200);
    expect(taken.body.ownerUserId).toBe(admin.id);
    await grantEditor(ws.id, { manageWorkflows: false });
  });
});

describe("OB-01 observability settings", () => {
  const url = () => `/workspaces/${ws.id}/observability/retention`;
  it("basic: everyone views retention and the token budget; Admin changes retention", async () => {
    const view = await request(app).get(url()).set("Cookie", editor.cookie);
    expect(view.status).toBe(200);
    expect(view.body.perTurnTokenLimit).toBeGreaterThan(0);
    for (const retentionDays of [7, 30, 90, 365]) {
      expect((await request(app).put(url()).set("Cookie", admin.cookie).send({ retentionDays })).body.retentionDays).toBe(retentionDays);
    }
  });
  it("edge: other retention values are 400", async () => {
    for (const retentionDays of [0, 1, 31, -7, "30days", null]) {
      expect((await request(app).put(url()).set("Cookie", admin.cookie).send({ retentionDays })).status).toBe(400);
    }
  });
  it("basic + edge: failure alert threshold saves alone and is bounded 1-20", async () => {
    expect((await request(app).put(url()).set("Cookie", admin.cookie).send({ failureAlertThreshold: 5 })).status).toBe(200);
    for (const failureAlertThreshold of [0, 21, 2.5, "five"]) {
      expect((await request(app).put(url()).set("Cookie", admin.cookie).send({ failureAlertThreshold })).status).toBe(400);
    }
  });
  it("security: Editors cannot change observability settings", async () => {
    expect((await request(app).put(url()).set("Cookie", editor.cookie).send({ retentionDays: 7 })).status).toBe(403);
    expect((await request(app).put(url()).set("Cookie", editor.cookie).send({ failureAlertThreshold: 3 })).status).toBe(403);
  });
});
