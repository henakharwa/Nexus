// Security Validation scope 14: abuse and cost limits.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import * as db from "@mai-chat/db";
import { closePool, getPool } from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, sentEmails, type TestUser } from "./helpers.js";
import { describeWait, tokenBudgetExhaustedMessage } from "../../src/abuse-limits.js";

const app = newApp();
const touchedEnv = new Map<string, string | undefined>();
function setLimit(name: string, value: number) {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  process.env[name] = String(value);
}
beforeAll(async () => {
  await setupDatabase();
});
afterEach(() => {
  for (const [name, previous] of touchedEnv) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  touchedEnv.clear();
});
afterAll(async () => {
  await closePool();
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("AC-01 rate limits on costly or abusable actions", () => {
  it("basic: workspace creation is capped per person with Retry-After and a readable message", async () => {
    setLimit("WORKSPACES_PER_USER_PER_DAY", 2);
    const person = await makeUser("Creator");
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post("/workspaces").set("Cookie", person.cookie).send({ name: `Cap ${i} ${person.id.slice(0, 6)}` })).status).toBe(201);
    }
    const refused = await request(app).post("/workspaces").set("Cookie", person.cookie).send({ name: `Cap 3 ${person.id.slice(0, 6)}` });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: "rate_limited" });
    expect(refused.body.error).toMatch(/limit for creating workspaces today \(2\)/);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // Someone else is unaffected.
    const other = await makeUser("Other creator");
    expect((await request(app).post("/workspaces").set("Cookie", other.cookie).send({ name: `Other ${other.id.slice(0, 6)}` })).status).toBe(201);
  });
  it("edge: an invalid request does not use up an attempt", async () => {
    setLimit("WORKSPACES_PER_USER_PER_DAY", 1);
    const person = await makeUser("Careful");
    expect((await request(app).post("/workspaces").set("Cookie", person.cookie).send({ name: "" })).status).toBe(400);
    expect((await request(app).post("/workspaces").set("Cookie", person.cookie).send({ name: `Ok ${person.id.slice(0, 6)}` })).status).toBe(201);
  });
  it("security: invitation emails are capped per workspace, so it can't be used as a spam relay", async () => {
    setLimit("INVITES_PER_WORKSPACE_PER_HOUR", 2);
    const admin = await makeUser("Inviter");
    const ws = await makeWorkspace(app, admin);
    const before = sentEmails.length;
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post(`/workspaces/${ws.id}/invitations`).set("Cookie", admin.cookie).send({ email: `spam-${i}-${ws.id.slice(0, 6)}@example.test`, role: "editor" })).status).toBe(201);
    }
    const refused = await request(app).post(`/workspaces/${ws.id}/invitations`).set("Cookie", admin.cookie).send({ email: `spam-3-${ws.id.slice(0, 6)}@example.test`, role: "editor" });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/invitations from this workspace/);
    expect(sentEmails.length - before).toBe(2);
  });
  it("security: one person's invitations are capped across all their workspaces", async () => {
    setLimit("INVITES_PER_USER_PER_DAY", 2);
    const admin = await makeUser("Serial inviter");
    const first = await makeWorkspace(app, admin);
    const second = await makeWorkspace(app, admin);
    expect((await request(app).post(`/workspaces/${first.id}/invitations`).set("Cookie", admin.cookie).send({ email: `a-${first.id.slice(0, 6)}@example.test`, role: "editor" })).status).toBe(201);
    expect((await request(app).post(`/workspaces/${second.id}/invitations`).set("Cookie", admin.cookie).send({ email: `b-${second.id.slice(0, 6)}@example.test`, role: "editor" })).status).toBe(201);
    const refused = await request(app).post(`/workspaces/${second.id}/invitations`).set("Cookie", admin.cookie).send({ email: `c-${second.id.slice(0, 6)}@example.test`, role: "editor" });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/sending invitations today/);
  });
  it("basic: agent creation is capped per person", async () => {
    setLimit("AGENTS_PER_USER_PER_HOUR", 2);
    const admin = await makeUser("Agent builder");
    const ws = await makeWorkspace(app, admin);
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post(`/workspaces/${ws.id}/agents`).set("Cookie", admin.cookie).send({ name: `Agent ${i}`, baseAgent: "project" })).status).toBe(201);
    }
    const refused = await request(app).post(`/workspaces/${ws.id}/agents`).set("Cookie", admin.cookie).send({ name: "Agent 3", baseAgent: "project" });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/creating agents this hour/);
  });
  it("basic: generated reports and drafts are capped per person", async () => {
    setLimit("AI_GENERATIONS_PER_USER_PER_HOUR", 2);
    const admin = await makeUser("Reporter");
    const ws = await makeWorkspace(app, admin);
    const report = (await request(app).post(`/workspaces/${ws.id}/artifacts`).set("Cookie", admin.cookie).send({ type: "report", status: "draft", title: "Weekly", content: "Notes" })).body;
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post(`/workspaces/${ws.id}/artifacts/${report.id}/generate-report`).set("Cookie", admin.cookie)).status).toBe(200);
    }
    const refused = await request(app).post(`/workspaces/${ws.id}/artifacts/${report.id}/generate-report`).set("Cookie", admin.cookie);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/AI drafts and generated reports/);
  });
  it("basic: manual workflow runs are capped per person", async () => {
    setLimit("WORKFLOW_RUNS_PER_USER_PER_HOUR", 1);
    const admin = await makeUser("Runner");
    const ws = await makeWorkspace(app, admin);
    const wf = (await request(app).post(`/workspaces/${ws.id}/workflows`).set("Cookie", admin.cookie).send({ name: "Capped", instructions: "Say hi" })).body;
    expect((await request(app).post(`/workspaces/${ws.id}/workflows/${wf.id}/run`).set("Cookie", admin.cookie).send({})).status).toBe(202);
    const refused = await request(app).post(`/workspaces/${ws.id}/workflows/${wf.id}/run`).set("Cookie", admin.cookie).send({});
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/manual workflow runs this hour/);
  });
  it("edge: wait times read naturally", () => {
    expect(describeWait(30)).toBe("in a minute");
    expect(describeWait(25 * 60)).toBe("in 25 minutes");
    expect(describeWait(5 * 3600)).toBe("in about 5 hours");
  });
});

describe("AC-02 daily AI token budget per workspace", () => {
  let admin: TestUser; let editor: TestUser;
  let ws: Awaited<ReturnType<typeof makeWorkspace>>;
  beforeAll(async () => {
    admin = await makeUser("Budget admin"); editor = await makeUser("Budget editor");
    ws = await makeWorkspace(app, admin, [editor]);
  });
  const budgetUrl = () => `/workspaces/${ws.id}/observability/token-budget`;

  it("basic: every member sees today's usage against the server default", async () => {
    const res = await request(app).get(budgetUrl()).set("Cookie", editor.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dailyLimit: 500_000, defaultLimit: 500_000, isCustom: false, usedToday: 0, exhausted: false });
    expect(new Date(res.body.resetsAt).getUTCHours()).toBe(0);
    expect(res.body.choices).toContain(1_000_000);
  });
  it("basic: workflow runs add their tokens to today's usage", async () => {
    const wf = (await request(app).post(`/workspaces/${ws.id}/workflows`).set("Cookie", admin.cookie).send({ name: "Counted", instructions: "Summarise the week" })).body;
    expect((await request(app).post(`/workspaces/${ws.id}/workflows/${wf.id}/run`).set("Cookie", admin.cookie).send({})).status).toBe(202);
    expect(await waitFor(async () => (await db.getWorkspaceTokenBudget(ws.id)).usedToday > 0)).toBe(true);
    expect((await db.getWorkspaceTokenBudget(ws.id)).agentTurnsToday).toBeGreaterThan(0);
  });
  it("basic: only Admins change the limit, choices are validated, and the change is logged", async () => {
    expect((await request(app).put(budgetUrl()).set("Cookie", editor.cookie).send({ dailyTokenBudget: 1_000_000 })).status).toBe(403);
    for (const bad of [123, -1, "lots", 0, 10_000_000]) {
      expect((await request(app).put(budgetUrl()).set("Cookie", admin.cookie).send({ dailyTokenBudget: bad })).status, String(bad)).toBe(400);
    }
    const saved = await request(app).put(budgetUrl()).set("Cookie", admin.cookie).send({ dailyTokenBudget: 1_000_000 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ dailyLimit: 1_000_000, isCustom: true });
    const events = await db.listAuditEvents(ws.id, { eventType: "workspace.budget_updated" });
    expect(events[0].summary).toMatch(/from 500,000 to 1,000,000 tokens/);
    const reset = await request(app).put(budgetUrl()).set("Cookie", admin.cookie).send({ dailyTokenBudget: null });
    expect(reset.body).toMatchObject({ dailyLimit: 500_000, isCustom: false });
  });
  it("security: once the budget is used up, manual runs and AI drafts are refused until the reset", async () => {
    await request(app).put(budgetUrl()).set("Cookie", admin.cookie).send({ dailyTokenBudget: 100_000 });
    await db.recordWorkspaceTokenUsage(ws.id, 100_000);
    const budget = (await request(app).get(budgetUrl()).set("Cookie", admin.cookie)).body;
    expect(budget).toMatchObject({ exhausted: true, remaining: 0 });

    const wf = (await request(app).post(`/workspaces/${ws.id}/workflows`).set("Cookie", admin.cookie).send({ name: "Over budget", instructions: "Say hi" })).body;
    const run = await request(app).post(`/workspaces/${ws.id}/workflows/${wf.id}/run`).set("Cookie", admin.cookie).send({});
    expect(run.status).toBe(429);
    expect(run.body.code).toBe("token_budget_exhausted");
    expect(run.body.error).toMatch(/daily AI budget of 100,000 tokens/);
    expect(Number(run.headers["retry-after"])).toBeGreaterThan(0);

    const plan = (await request(app).post(`/workspaces/${ws.id}/artifacts`).set("Cookie", admin.cookie).send({ type: "plan", status: "draft", title: "Plan", content: "Notes" })).body;
    const draft = await request(app).post(`/workspaces/${ws.id}/artifacts/${plan.id}/generate-assisted-draft`).set("Cookie", admin.cookie).send({ prompt: "x" });
    expect(draft.status).toBe(429);
    expect(draft.body.code).toBe("token_budget_exhausted");

    // Raising the limit lets work continue straight away.
    await request(app).put(budgetUrl()).set("Cookie", admin.cookie).send({ dailyTokenBudget: 250_000 });
    expect((await request(app).post(`/workspaces/${ws.id}/workflows/${wf.id}/run`).set("Cookie", admin.cookie).send({})).status).toBe(202);
  });
  it("edge: usage from another workspace or another day doesn't count", async () => {
    const other = await makeWorkspace(app, admin);
    expect((await db.getWorkspaceTokenBudget(other.id)).usedToday).toBe(0);
    await getPool().query(
      "INSERT INTO workspace_token_usage (workspace_id, usage_date, tokens, agent_turns) VALUES ($1, (now() AT TIME ZONE 'UTC')::date - 1, 9999999, 1)",
      [other.id],
    );
    const budget = await db.getWorkspaceTokenBudget(other.id);
    expect(budget).toMatchObject({ usedToday: 0, exhausted: false });
    expect(budget.recentDays).toHaveLength(1);
  });
  it("edge: WORKSPACE_DAILY_TOKEN_BUDGET changes the server default", async () => {
    setLimit("WORKSPACE_DAILY_TOKEN_BUDGET", 42_000);
    const fresh = await makeWorkspace(app, admin);
    expect((await db.getWorkspaceTokenBudget(fresh.id)).dailyLimit).toBe(42_000);
  });
  it("edge: the exhausted message names the limit and the reset", () => {
    const message = tokenBudgetExhaustedMessage({ dailyLimit: 250_000, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() });
    expect(message).toMatch(/250,000 tokens/);
    expect(message).toMatch(/midnight UTC \(in about 3 hours\)/);
    expect(message).toMatch(/Observability/);
  });
  it("security: outsiders can't read a workspace's budget", async () => {
    const outsider = await makeUser("Outsider");
    expect((await request(app).get(budgetUrl()).set("Cookie", outsider.cookie)).status).toBe(403);
  });
});
