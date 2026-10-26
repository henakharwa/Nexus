import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runMigrations } from "@mai-chat/db";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { getPool, closePool, upsertUserFromGithub, createSession, addWorkspaceMember, upsertSlackIntegration } from "@mai-chat/db";
import { createChatServer, type CreateServerDeps } from "../src/server.js";
import type { GithubClient, SlackClient } from "@mai-chat/integrations";

// Coverage for the Artifacts module (workspace_artifacts + comments +
// versions): CRUD and permissions, version history/restore, the
// Dashboard-specific live refresh + presence heartbeat, the Release
// Notes / Report "generate from activity" drafts, the generic share-link
// + public-view routes that now cover every artifact type, and
// Share-to-Slack. There was previously no dedicated test file for any of
// this -- see the docs on Plan/Report/Task list feature parity.

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

let postedMessages: { channel: string; text: string }[] = [];
const fakeGithubClient: GithubClient = {
  listIssues: async () => [],
  listPullRequests: async () => [],
};
const fakeSlackClient: SlackClient = { postMessage: async (channel, text) => { postedMessages.push({ channel, text }); } };

function makeDeps(overrides: Partial<CreateServerDeps> = {}): CreateServerDeps {
  return {
    githubClientFactory: () => fakeGithubClient,
    slackClientFactory: () => fakeSlackClient,
    githubMcpToolsFactory: async () => [],
    slackMcpToolsFactory: async () => [],
    runAgentTurn: async () => ({ reply: "Agent reply", toolCallsMade: 0 }),
    githubOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    githubOAuthDeps: { exchangeCodeForToken: async () => ({ error: "unused" }), listRepositoriesForToken: async () => [] },
    slackOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    slackOAuthDeps: { exchangeCodeForToken: async () => ({ error: "unused" }) },
    ...overrides,
  };
}

let ownerCookie: string;
let ownerId: string;
let editorCookie: string;
let editorId: string;
let outsiderCookie: string;

beforeAll(async () => {
  await runMigrations();
  const owner = await upsertUserFromGithub({ githubId: `artifacts-owner-${randomUUID()}`, username: "artifacts-owner", displayName: "Artifacts Owner" });
  ownerId = owner.id;
  ownerCookie = `mai_session=${(await createSession(owner.id, 60_000)).token}`;
  const editor = await upsertUserFromGithub({ githubId: `artifacts-editor-${randomUUID()}`, username: "artifacts-editor", displayName: "Artifacts Editor" });
  editorId = editor.id;
  editorCookie = `mai_session=${(await createSession(editor.id, 60_000)).token}`;
  const outsider = await upsertUserFromGithub({ githubId: `artifacts-outsider-${randomUUID()}`, username: "artifacts-outsider", displayName: "Artifacts Outsider" });
  outsiderCookie = `mai_session=${(await createSession(outsider.id, 60_000)).token}`;
});
afterAll(async () => { await closePool(); });

async function makeWorkspace(app: import("express").Express) {
  const created = await request(app).post("/workspaces").set("Cookie", ownerCookie).send({ name: `Artifacts WS ${randomUUID()}` });
  await addWorkspaceMember(created.body.id, editorId, "editor");
  return created.body as { id: string; name: string };
}

describe("artifacts: CRUD and permissions", () => {
  it("creates, lists, updates, and deletes a plan artifact", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);

    const create = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "Launch plan", summary: "Goals and milestones", content: "## Goal\n\n## Next step" });
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({ type: "plan", status: "draft", title: "Launch plan" });
    const artifactId = create.body.id as string;

    const list = await request(app).get(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie);
    expect(list.status).toBe(200);
    expect(list.body.map((item: { id: string }) => item.id)).toContain(artifactId);

    const update = await request(app).patch(`/workspaces/${workspace.id}/artifacts/${artifactId}`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "published", title: "Launch plan", summary: "Goals and milestones", content: "## Goal\n\nShip it\n\n## Next step" });
    expect(update.status).toBe(200);
    expect(update.body.status).toBe("published");
    expect(update.body.content).toContain("Ship it");

    const del = await request(app).delete(`/workspaces/${workspace.id}/artifacts/${artifactId}`).set("Cookie", ownerCookie);
    expect(del.status).toBe(204);
    const listAfter = await request(app).get(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie);
    expect(listAfter.body.map((item: { id: string }) => item.id)).not.toContain(artifactId);
  });

  it("rejects a missing title or content on create", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const res = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie).send({ type: "plan", status: "draft", title: "", summary: "", content: "" });
    expect(res.status).toBe(400);
  });

  it("blocks a non-author editor from editing or deleting someone else's artifact, but not an admin", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const create = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "report", status: "draft", title: "Weekly update", summary: "", content: "## Progress" });
    const artifactId = create.body.id as string;

    const editorUpdate = await request(app).patch(`/workspaces/${workspace.id}/artifacts/${artifactId}`).set("Cookie", editorCookie)
      .send({ type: "report", status: "draft", title: "Hijacked", summary: "", content: "## Progress" });
    expect(editorUpdate.status).toBe(403);

    const editorDelete = await request(app).delete(`/workspaces/${workspace.id}/artifacts/${artifactId}`).set("Cookie", editorCookie);
    expect(editorDelete.status).toBe(403);

    // The workspace creator is its first admin (see POST /workspaces),
    // so the owner's own cookie doubles as the admin case here.
    const adminUpdate = await request(app).patch(`/workspaces/${workspace.id}/artifacts/${artifactId}`).set("Cookie", ownerCookie)
      .send({ type: "report", status: "draft", title: "Admin edited", summary: "", content: "## Progress" });
    expect(adminUpdate.status).toBe(200);
  });

  it("keeps artifacts scoped to workspace members only", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const res = await request(app).get(`/workspaces/${workspace.id}/artifacts`).set("Cookie", outsiderCookie);
    expect(res.status).toBe(403);
  });

  it("requires the owner to be an actual workspace member", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const res = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "Plan", summary: "", content: "content", ownerUserId: randomUUID() });
    expect(res.status).toBe(400);
  });
});

describe("artifacts: version history", () => {
  it("records a version on every save and can restore an earlier one", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const create = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "v1 title", summary: "", content: "v1 content" });
    const artifactId = create.body.id as string;

    await request(app).patch(`/workspaces/${workspace.id}/artifacts/${artifactId}`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "v2 title", summary: "", content: "v2 content" });

    const versions = await request(app).get(`/workspaces/${workspace.id}/artifacts/${artifactId}/versions`).set("Cookie", ownerCookie);
    expect(versions.status).toBe(200);
    expect(versions.body.length).toBeGreaterThanOrEqual(2);
    const firstVersion = versions.body[versions.body.length - 1];
    expect(firstVersion.title).toBe("v1 title");

    const restore = await request(app).post(`/workspaces/${workspace.id}/artifacts/${artifactId}/versions/${firstVersion.id}/restore`).set("Cookie", ownerCookie);
    expect(restore.status).toBe(200);
    expect(restore.body.title).toBe("v1 title");
    expect(restore.body.content).toBe("v1 content");
  });
});

describe("artifacts: comments", () => {
  it("lets a workspace editor comment, and rejects an empty comment", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const create = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "Plan", summary: "", content: "content" });
    const artifactId = create.body.id as string;

    const comment = await request(app).post(`/workspaces/${workspace.id}/artifacts/${artifactId}/comments`).set("Cookie", editorCookie).send({ content: "Looks good" });
    expect(comment.status).toBe(201);
    expect(comment.body.content).toBe("Looks good");
    expect(comment.body.authorName).toBe("Artifacts Editor");

    const empty = await request(app).post(`/workspaces/${workspace.id}/artifacts/${artifactId}/comments`).set("Cookie", editorCookie).send({ content: "   " });
    expect(empty.status).toBe(400);

    const list = await request(app).get(`/workspaces/${workspace.id}/artifacts/${artifactId}/comments`).set("Cookie", ownerCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });
});

describe("artifacts: dashboard", () => {
  it("refreshes live data, only for dashboard-type artifacts, and preserves releaseVersion across the refresh", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);

    const plan = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "Plan", summary: "", content: "content" });
    const wrongType = await request(app).post(`/workspaces/${workspace.id}/artifacts/${plan.body.id}/refresh-dashboard`).set("Cookie", ownerCookie);
    expect(wrongType.status).toBe(400);

    const dashboard = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "dashboard", status: "draft", title: "Health", summary: "", content: "auto-generated" });
    const refreshed = await request(app).post(`/workspaces/${workspace.id}/artifacts/${dashboard.body.id}/refresh-dashboard`).set("Cookie", ownerCookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.dashboardData).toBeTruthy();
    expect(refreshed.body.dashboardData.health).toMatch(/on_track|at_risk|off_track/);
    // A dashboard never carries a release version, but a partial-update
    // bug would silently null out whatever's already on the row on every
    // write -- assert the field survives the round trip either way.
    expect(refreshed.body.releaseVersion).toBe(dashboard.body.releaseVersion ?? null);
  });

  it("tracks live presence heartbeats, excluding the caller from their own viewer list", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const dashboard = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "dashboard", status: "draft", title: "Health", summary: "", content: "auto-generated" });
    const artifactId = dashboard.body.id as string;

    const ownerPing = await request(app).post(`/workspaces/${workspace.id}/artifacts/${artifactId}/presence`).set("Cookie", ownerCookie);
    expect(ownerPing.status).toBe(200);
    expect(ownerPing.body.viewers).toEqual([]);

    const editorPing = await request(app).post(`/workspaces/${workspace.id}/artifacts/${artifactId}/presence`).set("Cookie", editorCookie);
    expect(editorPing.body.viewers.map((v: { name: string }) => v.name)).toEqual(["Artifacts Owner"]);

    const ownerPingAgain = await request(app).post(`/workspaces/${workspace.id}/artifacts/${artifactId}/presence`).set("Cookie", ownerCookie);
    expect(ownerPingAgain.body.viewers.map((v: { name: string }) => v.name)).toEqual(["Artifacts Editor"]);
  });
});

describe("artifacts: generate from activity", () => {
  it("drafts release notes from GitHub activity, gated to the release_notes type", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const plan = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "Plan", summary: "", content: "content" });
    const wrongType = await request(app).post(`/workspaces/${workspace.id}/artifacts/${plan.body.id}/generate-release-notes`).set("Cookie", ownerCookie);
    expect(wrongType.status).toBe(400);

    const releaseNotes = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "release_notes", status: "draft", title: "v1.0", summary: "", content: "## Highlights" });
    const generated = await request(app).post(`/workspaces/${workspace.id}/artifacts/${releaseNotes.body.id}/generate-release-notes`).set("Cookie", ownerCookie);
    expect(generated.status).toBe(200);
    expect(generated.body.content).toContain("## Highlights");
  });

  it("drafts a report from workspace activity, gated to the report type", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const plan = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "Plan", summary: "", content: "content" });
    const wrongType = await request(app).post(`/workspaces/${workspace.id}/artifacts/${plan.body.id}/generate-report`).set("Cookie", ownerCookie);
    expect(wrongType.status).toBe(400);

    const report = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "report", status: "draft", title: "Weekly update", summary: "", content: "## Progress" });
    const generated = await request(app).post(`/workspaces/${workspace.id}/artifacts/${report.body.id}/generate-report`).set("Cookie", ownerCookie);
    expect(generated.status).toBe(200);
    expect(generated.body.content).toContain("## Progress");
    expect(generated.body.content).toContain("## Risks");
    expect(generated.body.content).toContain("## Next step");
  });
});

describe("artifacts: share links and public views", () => {
  it("creates and revokes a public link for a dashboard, serving the safe view only while published", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const dashboard = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "dashboard", status: "published", title: "Health", summary: "", content: "auto-generated" });
    const artifactId = dashboard.body.id as string;

    const shared = await request(app).post(`/workspaces/${workspace.id}/artifacts/${artifactId}/share`).set("Cookie", ownerCookie);
    expect(shared.status).toBe(200);
    expect(shared.body.shareToken).toBeTruthy();

    const publicView = await request(app).get(`/public/dashboards/${shared.body.shareToken}`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.title).toBe("Health");
    expect(publicView.body).not.toHaveProperty("content"); // safe view only

    const revoked = await request(app).delete(`/workspaces/${workspace.id}/artifacts/${artifactId}/share`).set("Cookie", ownerCookie);
    expect(revoked.status).toBe(200);
    expect(revoked.body.shareToken).toBeNull();

    const afterRevoke = await request(app).get(`/public/dashboards/${shared.body.shareToken}`);
    expect(afterRevoke.status).toBe(404);
  });

  it("shares a plan/report/task_list artifact through the generic public route, only once published", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const plan = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "Launch plan", summary: "Team plan", content: "- [x] Confirm owner\n- [ ] Ship it" });
    const artifactId = plan.body.id as string;

    const shared = await request(app).post(`/workspaces/${workspace.id}/artifacts/${artifactId}/share`).set("Cookie", ownerCookie);
    expect(shared.status).toBe(200);
    const token = shared.body.shareToken as string;

    // Still a draft -- the public route requires status = 'published',
    // same rule as Dashboard and Release Notes.
    const whileDraft = await request(app).get(`/public/artifacts/${token}`);
    expect(whileDraft.status).toBe(404);

    await request(app).patch(`/workspaces/${workspace.id}/artifacts/${artifactId}`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "published", title: "Launch plan", summary: "Team plan", content: "- [x] Confirm owner\n- [ ] Ship it" });

    const published = await request(app).get(`/public/artifacts/${token}`);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ type: "plan", title: "Launch plan", summary: "Team plan" });
    expect(published.body.content).toContain("Ship it");
  });

  it("returns 404 for an unknown or malformed share token on every public route", async () => {
    const { app } = createChatServer(makeDeps());
    const bogus = randomUUID();
    expect((await request(app).get(`/public/dashboards/${bogus}`)).status).toBe(404);
    expect((await request(app).get(`/public/release-notes/${bogus}`)).status).toBe(404);
    expect((await request(app).get(`/public/artifacts/${bogus}`)).status).toBe(404);
  });

  it("only lets the author or an admin create or revoke a share link", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const plan = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "plan", status: "draft", title: "Plan", summary: "", content: "content" });
    const res = await request(app).post(`/workspaces/${workspace.id}/artifacts/${plan.body.id}/share`).set("Cookie", editorCookie);
    expect(res.status).toBe(403);
  });
});

describe("artifacts: share to Slack", () => {
  it("posts any artifact type to Slack once connected, and records a type-accurate audit summary", async () => {
    postedMessages = [];
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    await upsertSlackIntegration({ workspaceId: workspace.id, teamName: "Artifacts QA", token: "xoxp-fake", ownerUserId: ownerId });

    const report = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "report", status: "published", title: "Weekly update", summary: "", content: "## Progress\n\nShipped the thing" });

    const shared = await request(app).post(`/workspaces/${workspace.id}/artifacts/${report.body.id}/share-to-slack`).set("Cookie", ownerCookie).send({ channel: "team-updates" });
    expect(shared.status).toBe(204);
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].channel).toBe("team-updates");
    expect(postedMessages[0].text).toContain("Weekly update");

    const audit = await request(app).get(`/workspaces/${workspace.id}/audit`).set("Cookie", ownerCookie);
    const entry = audit.body.events.find((event: { summary: string }) => event.summary.includes("shared"));
    expect(entry).toBeTruthy();
    // A report shared to Slack should say "report", not the old
    // hardcoded "release notes" wording from when this route only
    // supported that one type.
    expect(entry.summary).toContain("report");
    expect(entry.summary).not.toContain("release notes");
  });

  it("requires a channel and a connected Slack integration", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await makeWorkspace(app);
    const report = await request(app).post(`/workspaces/${workspace.id}/artifacts`).set("Cookie", ownerCookie)
      .send({ type: "report", status: "draft", title: "Weekly update", summary: "", content: "## Progress" });

    const noChannel = await request(app).post(`/workspaces/${workspace.id}/artifacts/${report.body.id}/share-to-slack`).set("Cookie", ownerCookie).send({});
    expect(noChannel.status).toBe(400);

    const notConnected = await request(app).post(`/workspaces/${workspace.id}/artifacts/${report.body.id}/share-to-slack`).set("Cookie", ownerCookie).send({ channel: "team-updates" });
    expect(notConnected.status).toBe(400);
  });
});
