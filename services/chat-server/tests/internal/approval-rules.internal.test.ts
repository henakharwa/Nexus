// Approval rules end to end: the Admin-only rules API, what happens when the
// agent proposes a write (block, auto-approve, require approvals), and the
// multi-approver confirm flow. Real Express app + real Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as db from "@mai-chat/db";
import type { ApprovalRuleInput } from "@mai-chat/shared-types";
import type { ToolExecutor } from "../../src/tools.js";
import { expireStaleActions, wrapForProposal, type GithubLookups } from "../../src/actions.js";
import { RoomRegistry } from "../../src/rooms.js";
import { setupDatabase, makeUser, newApp, makeWorkspace, grantEditor, type TestUser } from "./helpers.js";

let executions = 0;
const writeTool: ToolExecutor = {
  definition: { type: "function", function: { name: "fake_comment_tool", description: "fake", parameters: { type: "object" } } },
  mutates: true,
  describe: () => "comment on issue 3",
  execute: async () => {
    executions += 1;
    return { ok: true, url: "https://github.com/acme/widgets/issues/3#comment-1" };
  },
};

const app = newApp({ githubMcpToolsFactory: async () => [writeTool] });
let requester: TestUser;
let approverA: TestUser;
let approverB: TestUser;
let editor: TestUser;

beforeAll(async () => {
  await setupDatabase();
  requester = await makeUser("Requester");
  approverA = await makeUser("ApproverA");
  approverB = await makeUser("ApproverB");
  editor = await makeUser("Editor");
});
afterAll(async () => {
  await db.closePool();
});

/** A fresh workspace (rules are per workspace) where the requester and both approvers are Admins. */
async function freshWorkspace() {
  const ws = await makeWorkspace(app, requester, [approverA, approverB, editor]);
  await db.setWorkspaceMemberRole(ws.id, approverA.id, "admin");
  await db.setWorkspaceMemberRole(ws.id, approverB.id, "admin");
  // Actions run with the requester's own connection.
  await db.upsertGithubIntegration({ workspaceId: ws.id, owner: "acme", repo: "widgets", token: "gh-token", connectionName: "My GitHub", connectionScope: "personal", ownerUserId: requester.id });
  return ws;
}

const ruleBody = (overrides: Partial<ApprovalRuleInput>): ApprovalRuleInput => ({
  name: "Test rule",
  enabled: true,
  provider: "github",
  categories: [],
  repoPattern: null,
  branchPattern: null,
  channelPattern: null,
  effect: "require_approvals",
  requiredApprovals: 2,
  ...overrides,
});

async function addRule(workspaceId: string, overrides: Partial<ApprovalRuleInput>) {
  const res = await request(app).post(`/workspaces/${workspaceId}/approval-rules`).set("Cookie", requester.cookie).send(ruleBody(overrides));
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}

/** Runs the agent's proposal path for one write, as the requester. */
async function propose(
  ws: { id: string; conversationId: string },
  options: Parameters<typeof wrapForProposal>[6] = {},
  args: Record<string, unknown> = {},
  agentKind: Parameters<typeof wrapForProposal>[5] = "github"
) {
  const [wrapped] = wrapForProposal([writeTool], ws.id, ws.conversationId, new RoomRegistry(), { userId: requester.id, name: requester.displayName }, agentKind, options);
  return (await wrapped.execute(args)) as Record<string, unknown>;
}

const confirm = (workspaceId: string, actionId: string, user: TestUser) => request(app).post(`/workspaces/${workspaceId}/actions/${actionId}/confirm`).set("Cookie", user.cookie).send({});

describe("approval rules API", () => {
  it("every member can read the rules; only Admins can change them", async () => {
    const ws = await freshWorkspace();
    const rule = await addRule(ws.id, { name: "Two approvers" });
    const listed = await request(app).get(`/workspaces/${ws.id}/approval-rules`).set("Cookie", editor.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.map((item: { id: string }) => item.id)).toEqual([rule.id]);
    expect((await request(app).post(`/workspaces/${ws.id}/approval-rules`).set("Cookie", editor.cookie).send(ruleBody({}))).status).toBe(403);
    expect((await request(app).put(`/workspaces/${ws.id}/approval-rules/${rule.id}`).set("Cookie", editor.cookie).send(ruleBody({}))).status).toBe(403);
    expect((await request(app).delete(`/workspaces/${ws.id}/approval-rules/${rule.id}`).set("Cookie", editor.cookie)).status).toBe(403);
  });

  it("validates input, updates and deletes rules, and logs each change", async () => {
    const ws = await freshWorkspace();
    const bad = await request(app).post(`/workspaces/${ws.id}/approval-rules`).set("Cookie", requester.cookie).send(ruleBody({ repoPattern: "no-owner" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("owner/name");
    const rule = await addRule(ws.id, { name: "Block deletes", effect: "block", requiredApprovals: null, categories: ["delete"] });
    const updated = await request(app).put(`/workspaces/${ws.id}/approval-rules/${rule.id}`).set("Cookie", requester.cookie).send(ruleBody({ name: "Block deletes", effect: "block", requiredApprovals: null, categories: ["delete"], enabled: false }));
    expect(updated.status).toBe(200);
    expect(updated.body.enabled).toBe(false);
    expect((await request(app).delete(`/workspaces/${ws.id}/approval-rules/${rule.id}`).set("Cookie", requester.cookie)).status).toBe(204);
    expect((await request(app).delete(`/workspaces/${ws.id}/approval-rules/${rule.id}`).set("Cookie", requester.cookie)).status).toBe(404);
    const events = (await db.listAuditEvents(ws.id)).map((event) => [event.eventType, event.summary]);
    expect(events).toContainEqual(["approval_rule.created", "Requester created approval rule “Block deletes”, which blocks matching actions"]);
    expect(events).toContainEqual(["approval_rule.updated", "Requester turned off approval rule “Block deletes”, which blocks matching actions"]);
    expect(events).toContainEqual(["approval_rule.deleted", "Requester deleted approval rule “Block deletes”"]);
  });

  it("rules from one workspace can't be changed through another", async () => {
    const mine = await freshWorkspace();
    const theirs = await freshWorkspace();
    const rule = await addRule(theirs.id, {});
    expect((await request(app).delete(`/workspaces/${mine.id}/approval-rules/${rule.id}`).set("Cookie", requester.cookie)).status).toBe(404);
    expect((await db.listApprovalRules(theirs.id)).length).toBe(1);
  });
});

describe("rules applied when the agent proposes a write", () => {
  it("a block rule refuses the action before anyone is asked", async () => {
    const ws = await freshWorkspace();
    await addRule(ws.id, { name: "No GitHub writes", effect: "block", requiredApprovals: null });
    const before = executions;
    const result = await propose(ws);
    expect(result).toMatchObject({ status: "blocked_by_rule", rule: "No GitHub writes" });
    expect(executions).toBe(before);
    expect(await db.listPendingActions(ws.id, ws.conversationId)).toHaveLength(0);
    expect((await db.listAuditEvents(ws.id)).some((event) => event.eventType === "action.blocked")).toBe(true);
  });

  it("an auto-approve rule runs the action at once and records it", async () => {
    const ws = await freshWorkspace();
    await addRule(ws.id, { name: "Comments are fine", effect: "auto_approve", requiredApprovals: null, categories: ["comment"] });
    const before = executions;
    const result = await propose(ws);
    expect(result).toMatchObject({ status: "completed", autoApproved: true, approvedBy: "rule “Comments are fine”" });
    expect(executions).toBe(before + 1);
    const [action] = await db.listPendingActions(ws.id, ws.conversationId);
    expect(action).toMatchObject({ status: "confirmed", autoApproved: true, approvalRuleName: "Comments are fine", executedAsUserId: requester.id });
    const events = await db.listAuditEvents(ws.id);
    expect(events.some((event) => event.eventType === "action.auto_approved")).toBe(true);
  });

  it("a workflow marked Requires approval still gets a card under an auto-approve rule", async () => {
    const ws = await freshWorkspace();
    await addRule(ws.id, { name: "Comments are fine", effect: "auto_approve", requiredApprovals: null });
    const before = executions;
    const result = await propose(ws, { allowAutoApprove: false });
    expect(result.status).toBe("awaiting_user_confirmation");
    expect(executions).toBe(before);
    const [action] = await db.listPendingActions(ws.id, ws.conversationId, true);
    expect(action).toMatchObject({ status: "pending", requiredApprovals: 1, autoApproved: false, approvalRuleName: null });
  });

  it("the strictest matching rule wins", async () => {
    const ws = await freshWorkspace();
    await addRule(ws.id, { name: "Auto", effect: "auto_approve", requiredApprovals: null });
    await addRule(ws.id, { name: "Three people", requiredApprovals: 3 });
    await addRule(ws.id, { name: "Two people", requiredApprovals: 2 });
    const result = await propose(ws);
    expect(result).toMatchObject({ status: "awaiting_user_confirmation", requiredApprovals: 3, rule: "Three people" });
  });
});

describe("approving an action that needs several approvals", () => {
  it("needs two approvers other than the requester, each counted once", async () => {
    const ws = await freshWorkspace();
    await addRule(ws.id, { name: "Two approvers" });
    const { actionId } = (await propose(ws)) as { actionId: string };
    const before = executions;

    const own = await confirm(ws.id, actionId, requester);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe("requester_cannot_approve");

    const first = await confirm(ws.id, actionId, approverA);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "pending", requiredApprovals: 2 });
    expect(first.body.approvals.map((approval: { userId: string }) => approval.userId)).toEqual([approverA.id]);
    expect(executions).toBe(before);

    const again = await confirm(ws.id, actionId, approverA);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_approved");

    const second = await confirm(ws.id, actionId, approverB);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("confirmed");
    expect(executions).toBe(before + 1);
    const action = await db.getPendingAction(ws.id, actionId);
    expect(action?.approvals?.map((approval) => approval.userId)).toEqual([approverA.id, approverB.id]);
    const confirmed = (await db.listAuditEvents(ws.id)).find((event) => event.eventType === "action.confirmed");
    expect(confirmed?.metadata).toMatchObject({ ruleName: "Two approvers", approvedBy: "ApproverA and ApproverB", requiredApprovals: 2 });
    const messages = await db.listMessages(ws.id, ws.conversationId);
    expect(messages.some((message) => message.content.startsWith("ApproverA approved (1 of 2 under rule “Two approvers”)"))).toBe(true);
  });

  it("a rule added after the action was proposed still applies when it's approved", async () => {
    const ws = await freshWorkspace();
    const { actionId } = (await propose(ws)) as { actionId: string };
    await addRule(ws.id, { name: "Freeze", effect: "block", requiredApprovals: null });
    const before = executions;
    const res = await confirm(ws.id, actionId, approverA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("blocked_by_rule");
    expect(executions).toBe(before);
    expect((await db.getPendingAction(ws.id, actionId))?.status).toBe("cancelled");
  });

  it("a stricter rule added later raises the number of approvals needed", async () => {
    const ws = await freshWorkspace();
    const { actionId } = (await propose(ws)) as { actionId: string };
    await addRule(ws.id, { name: "Two approvers" });
    const first = await confirm(ws.id, actionId, approverA);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("pending");
  });

  it("without rules, nothing changes: the requester can still confirm their own action", async () => {
    const ws = await freshWorkspace();
    const { actionId } = (await propose(ws)) as { actionId: string };
    const res = await confirm(ws.id, actionId, requester);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("confirmed");
  });
});

describe("approvals expire", () => {
  it("an action waiting past the window can't be confirmed, and is cancelled", async () => {
    const ws = await freshWorkspace();
    const { actionId } = (await propose(ws)) as { actionId: string };
    await db.getPool().query("UPDATE pending_actions SET created_at = now() - interval '25 hours' WHERE id = $1", [actionId]);
    const before = executions;
    const res = await confirm(ws.id, actionId, approverA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("expired");
    expect(executions).toBe(before);
    expect((await db.getPendingAction(ws.id, actionId))?.status).toBe("cancelled");
    expect((await db.listAuditEvents(ws.id)).some((event) => event.eventType === "action.expired")).toBe(true);
  });

  it("the background sweep cancels stale actions and leaves fresh ones", async () => {
    const ws = await freshWorkspace();
    const stale = (await propose(ws)) as { actionId: string };
    const fresh = (await propose(ws)) as { actionId: string };
    await db.getPool().query("UPDATE pending_actions SET created_at = now() - interval '30 hours' WHERE id = $1", [stale.actionId]);
    await expireStaleActions(new RoomRegistry());
    expect((await db.getPendingAction(ws.id, stale.actionId))?.status).toBe("cancelled");
    expect((await db.getPendingAction(ws.id, fresh.actionId))?.status).toBe("pending");
    const messages = await db.listMessages(ws.id, ws.conversationId);
    expect(messages.some((message) => message.content.startsWith("Expired without approval"))).toBe(true);
  });

  it("each action says when it expires", async () => {
    const ws = await freshWorkspace();
    const { actionId } = (await propose(ws)) as { actionId: string };
    const action = await db.getPendingAction(ws.id, actionId);
    const hours = (Date.parse(action!.expiresAt!) - Date.parse(action!.createdAt)) / 3_600_000;
    expect(hours).toBe(24);
  });
});

describe("the person an action runs as must still be allowed to use the tool", () => {
  it("fails instead of running a write as someone whose role lost the tool", async () => {
    const ws = await makeWorkspace(app, approverA, [editor]);
    await db.upsertGithubIntegration({ workspaceId: ws.id, owner: "acme", repo: "widgets", token: "gh-token-editor", connectionName: "Editor GitHub", connectionScope: "personal", ownerUserId: editor.id });
    const [wrapped] = wrapForProposal([writeTool], ws.id, ws.conversationId, new RoomRegistry(), { userId: editor.id, name: editor.displayName }, "github");
    const { actionId } = (await wrapped.execute({})) as { actionId: string };
    await grantEditor(ws.id, { github: false });
    const listed = await request(app).get(`/workspaces/${ws.id}/actions?conversationId=${ws.conversationId}`).set("Cookie", approverA.cookie);
    expect(listed.body.find((action: { id: string }) => action.id === actionId).runAsAvailable).toBe(false);
    const before = executions;
    const res = await confirm(ws.id, actionId, approverA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("tool_not_permitted");
    expect(executions).toBe(before);
    expect((await db.getPendingAction(ws.id, actionId))?.result).toContain("no longer has permission to use GitHub");
  });

  it("refuses Run as me when the approver's own role can't use the tool", async () => {
    const ws = await makeWorkspace(app, requester, [editor]);
    await grantEditor(ws.id, { approveActions: true, github: false });
    const { actionId } = (await propose(ws)) as { actionId: string };
    const res = await request(app).post(`/workspaces/${ws.id}/actions/${actionId}/confirm`).set("Cookie", editor.cookie).send({ runAs: "me" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("tool_not_permitted");
  });
});

describe("starter policy", () => {
  it("adds the recommended rules once, sized to who can approve", async () => {
    const ws = await freshWorkspace();
    expect((await request(app).get(`/workspaces/${ws.id}/approval-rules/capacity`).set("Cookie", editor.cookie)).body).toEqual({ approvers: 3 });
    expect((await request(app).post(`/workspaces/${ws.id}/approval-rules/starter`).set("Cookie", editor.cookie)).status).toBe(403);
    const first = await request(app).post(`/workspaces/${ws.id}/approval-rules/starter`).set("Cookie", requester.cookie);
    expect(first.status).toBe(201);
    expect(first.body.map((rule: { name: string }) => rule.name)).toEqual(["Block deletes and archives", "Production changes need two people", "Comments run without approval"]);
    const second = await request(app).post(`/workspaces/${ws.id}/approval-rules/starter`).set("Cookie", requester.cookie);
    expect(second.body).toEqual([]);
    expect(await db.listApprovalRules(ws.id)).toHaveLength(3);
  });

  it("asks for one other approver when the team is too small for two", async () => {
    const ws = await makeWorkspace(app, requester, [editor]);
    const res = await request(app).post(`/workspaces/${ws.id}/approval-rules/starter`).set("Cookie", requester.cookie);
    expect(res.body[1]).toMatchObject({ name: "Production changes need a second person", requiredApprovals: 1 });
  });
});

describe("standing approvals", () => {
  it("approving with remember runs similar actions without a card, until revoked", async () => {
    const ws = await freshWorkspace();
    const first = (await propose(ws)) as { actionId: string };
    const confirmed = await request(app).post(`/workspaces/${ws.id}/actions/${first.actionId}/confirm`).set("Cookie", approverA.cookie).send({ remember: true });
    expect(confirmed.status).toBe(200);
    const [standing] = (await request(app).get(`/workspaces/${ws.id}/standing-approvals`).set("Cookie", editor.cookie)).body;
    expect(standing).toMatchObject({ toolName: "fake_comment_tool", scopeLabel: "GitHub", createdByName: "ApproverA" });

    const before = executions;
    const second = await propose(ws);
    expect(second).toMatchObject({ status: "completed", autoApproved: true });
    expect(String(second.approvedBy)).toContain("ApproverA's standing approval");
    expect(executions).toBe(before + 1);

    // Only an Admin or the person who gave it can revoke it.
    expect((await request(app).delete(`/workspaces/${ws.id}/standing-approvals/${standing.id}`).set("Cookie", editor.cookie)).status).toBe(403);
    expect((await request(app).delete(`/workspaces/${ws.id}/standing-approvals/${standing.id}`).set("Cookie", approverB.cookie)).status).toBe(204);
    expect((await propose(ws)).status).toBe("awaiting_user_confirmation");
    const events = (await db.listAuditEvents(ws.id)).map((event) => event.eventType);
    expect(events).toEqual(expect.arrayContaining(["standing_approval.created", "standing_approval.revoked", "action.auto_approved"]));
  });

  it("never overrides a rule that asks for more than a normal card, or a workflow that requires approval", async () => {
    const ws = await freshWorkspace();
    const first = (await propose(ws)) as { actionId: string };
    await request(app).post(`/workspaces/${ws.id}/actions/${first.actionId}/confirm`).set("Cookie", approverA.cookie).send({ remember: true });
    expect((await propose(ws, { allowAutoApprove: false })).status).toBe("awaiting_user_confirmation");
    await addRule(ws.id, { name: "Two approvers" });
    const governed = (await propose(ws)) as { status: string; actionId: string };
    expect(governed.status).toBe("awaiting_user_confirmation");
    const remember = await request(app).post(`/workspaces/${ws.id}/actions/${governed.actionId}/confirm`).set("Cookie", approverA.cookie).send({ remember: true });
    expect(remember.status).toBe(400);
    expect(remember.body.code).toBe("standing_not_allowed");
  });
});

describe("more precise matching", () => {
  const lookups = (protection: { protected: boolean; requiredReviews: number | null } | null): GithubLookups => ({
    pullRequestBase: async () => "main",
    defaultBranch: async () => "main",
    branchProtection: async () => protection,
  });

  it("a merge is matched by the branch its pull request goes into, and GitHub's own protection is recorded", async () => {
    const ws = await freshWorkspace();
    await addRule(ws.id, { name: "Merges into main", categories: ["merge"], branchPattern: "main" });
    await addRule(ws.id, { name: "Merges elsewhere are fine", effect: "auto_approve", requiredApprovals: null, categories: ["merge"] });
    const mergeTool: ToolExecutor = { ...writeTool, definition: { type: "function", function: { name: "merge_pull_request", description: "merge", parameters: { type: "object" } } } };
    const [wrapped] = wrapForProposal([mergeTool], ws.id, ws.conversationId, new RoomRegistry(), { userId: requester.id, name: requester.displayName }, "github", { githubLookups: lookups({ protected: true, requiredReviews: 1 }) });
    const result = (await wrapped.execute({ owner: "acme", repo: "widgets", pullNumber: 7 })) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "awaiting_user_confirmation", rule: "Merges into main", github: "GitHub protects main and requires 1 approving review on pull requests into it." });
    const action = await db.getPendingAction(ws.id, result.actionId as string);
    expect(action?.target).toMatchObject({ baseBranch: "main", branchProtection: { branch: "main", protected: true, requiredReviews: 1 } });
  });

  it("a Slack rule written with a channel name matches an action that uses the channel ID", async () => {
    const ws = await freshWorkspace();
    await addRule(ws.id, { name: "No posts to announcements", provider: "slack", effect: "block", requiredApprovals: null, channelPattern: "announcements" });
    await addRule(ws.id, { name: "Other channels are fine", provider: "slack", effect: "auto_approve", requiredApprovals: null });
    const blocked = await propose(ws, { slackChannelName: async (id) => (id === "C024BE91L" ? "announcements" : "random") }, { channel_id: "C024BE91L", message: "hi" }, "slack");
    expect(blocked).toMatchObject({ status: "blocked_by_rule", rule: "No posts to announcements" });
    const allowed = await propose(ws, { slackChannelName: async () => "random" }, { channel_id: "C099ZZZ99", message: "hi" }, "slack");
    expect(allowed).toMatchObject({ status: "completed", autoApproved: true });
  });
});

describe("the agent is told the rules", () => {
  it("passes the rules for its tool to the agent turn, and none to read-only runs", async () => {
    const seen: Array<string | null | undefined> = [];
    // A read-only run needs at least one read tool, or it stops before the agent runs.
    const readTool: ToolExecutor = { definition: { type: "function", function: { name: "list_commits", description: "List commits", parameters: { type: "object" } } }, execute: async () => [] };
    const watchingApp = newApp({ githubMcpToolsFactory: async () => [readTool, writeTool], runAgentTurn: async (input) => {
      seen.push(input.approvalRules);
      return { reply: "ok", toolCallsMade: 0 };
    } });
    const ws = await makeWorkspace(watchingApp, requester);
    await db.upsertGithubIntegration({ workspaceId: ws.id, owner: "acme", repo: "widgets", token: "gh-token-rules", connectionName: "GitHub", connectionScope: "personal", ownerUserId: requester.id });
    await request(watchingApp).post(`/workspaces/${ws.id}/approval-rules`).set("Cookie", requester.cookie).send(ruleBody({ name: "Production merges", categories: ["merge"], branchPattern: "main" }));
    await request(watchingApp).post(`/workspaces/${ws.id}/approval-rules`).set("Cookie", requester.cookie).send(ruleBody({ name: "Slack only", provider: "slack", effect: "block", requiredApprovals: null }));

    const run = async (instructions: string) => {
      const workflow = (await request(watchingApp).post(`/workspaces/${ws.id}/workflows`).set("Cookie", requester.cookie).send({ name: `Run ${seen.length}`, instructions, agentKind: "github" })).body;
      const before = seen.length;
      expect((await request(watchingApp).post(`/workspaces/${ws.id}/workflows/${workflow.id}/run`).set("Cookie", requester.cookie).send({})).status).toBe(202);
      for (let i = 0; i < 100 && seen.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen.length).toBe(before + 1);
      return seen[seen.length - 1];
    };
    const writing = await run("Merge pull request 4 when its checks pass.");
    expect(writing).toContain('"Production merges": GitHub: merge on main needs 2 approvals');
    expect(writing).not.toContain("Slack only");
    expect(await run("Report on the recent commits.")).toBeNull();
  });
});
