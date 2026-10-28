// Conversations, message history and the activity (audit) log.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as db from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, NIL_UUID, type TestUser } from "./helpers.js";

const app = newApp();
let admin: TestUser; let editor: TestUser; let outsider: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;
beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin"); editor = await makeUser("Editor"); outsider = await makeUser("Outsider");
  ws = await makeWorkspace(app, admin, [editor]);
});
afterAll(async () => { await db.closePool(); });

const base = () => `/workspaces/${ws.id}/conversations`;

describe("CV-01 create and list conversations", () => {
  it("basic: Editors and Admins create conversations and see each other's", async () => {
    const created = await request(app).post(base()).set("Cookie", editor.cookie).send({ title: "Planning" });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe("Planning");
    const list = await request(app).get(base()).set("Cookie", admin.cookie);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(created.body.id);
  });
  it("edge: a missing or blank title falls back to a default; long titles are trimmed to 100", async () => {
    const blank = await request(app).post(base()).set("Cookie", admin.cookie).send({ title: "   " });
    expect(blank.body.title).toBe("New conversation");
    const long = await request(app).post(base()).set("Cookie", admin.cookie).send({ title: "x".repeat(500) });
    expect(long.body.title.length).toBe(100);
  });
  it("security: outsiders cannot list or create", async () => {
    expect((await request(app).get(base()).set("Cookie", outsider.cookie)).status).toBe(403);
    expect((await request(app).post(base()).set("Cookie", outsider.cookie).send({})).status).toBe(403);
  });
});

describe("CV-02 rename, pin, archive", () => {
  it("basic: rename, pin and archive in one or several requests", async () => {
    const created = (await request(app).post(base()).set("Cookie", admin.cookie).send({ title: "Old" })).body;
    const renamed = await request(app).patch(`${base()}/${created.id}`).set("Cookie", editor.cookie).send({ title: "  New  ", pinned: true });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe("New");
    expect(renamed.body.pinnedAt).toBeTruthy();
    const archived = await request(app).patch(`${base()}/${created.id}`).set("Cookie", admin.cookie).send({ archived: true });
    expect(archived.body.archivedAt).toBeTruthy();
  });
  it("security: Editors cannot archive or restore, and a rejected request changes nothing", async () => {
    const created = (await request(app).post(base()).set("Cookie", editor.cookie).send({ title: "Keep" })).body;
    const archive = await request(app).patch(`${base()}/${created.id}`).set("Cookie", editor.cookie).send({ archived: true, title: "Changed" });
    expect(archive.status).toBe(403);
    expect(archive.body.error).toMatch(/Only Admins can archive/);
    const unchanged = await db.getConversation(ws.id, created.id);
    expect(unchanged?.archivedAt).toBeNull();
    expect(unchanged?.title).toBe("Keep");
    await request(app).patch(`${base()}/${created.id}`).set("Cookie", admin.cookie).send({ archived: true });
    expect((await request(app).patch(`${base()}/${created.id}`).set("Cookie", editor.cookie).send({ archived: false })).status).toBe(403);
    expect((await request(app).patch(`${base()}/${created.id}`).set("Cookie", admin.cookie).send({ archived: false })).body.archivedAt).toBeNull();
    for (const eventType of ["conversation.archived", "conversation.restored"] as const) {
      const events = await db.listAuditEvents(ws.id, { eventType });
      expect(events.some((event) => event.summary === "Admin " + eventType.split(".")[1] + " conversation Keep" && event.actorUserId === admin.id)).toBe(true);
    }
  });
  it("edge: blank or >100 character titles are 400; wrong types are ignored", async () => {
    expect((await request(app).patch(`${base()}/${ws.conversationId}`).set("Cookie", admin.cookie).send({ title: "  " })).status).toBe(400);
    expect((await request(app).patch(`${base()}/${ws.conversationId}`).set("Cookie", admin.cookie).send({ title: "y".repeat(101) })).status).toBe(400);
    const ignored = await request(app).patch(`${base()}/${ws.conversationId}`).set("Cookie", admin.cookie).send({ pinned: "yes" });
    expect(ignored.status).toBe(200);
    expect(ignored.body.pinnedAt).toBeNull();
  });
  it("edge: unknown conversation 404; malformed id is rejected without a server error", async () => {
    expect((await request(app).patch(`${base()}/${NIL_UUID}`).set("Cookie", admin.cookie).send({ title: "x" })).status).toBe(404);
    const malformed = await request(app).patch(`${base()}/abc`).set("Cookie", admin.cookie).send({ title: "x" });
    expect([400, 404]).toContain(malformed.status);
  });
  it("security: a conversation from another workspace cannot be changed through this one", async () => {
    const other = await makeWorkspace(app, outsider);
    expect((await request(app).patch(`${base()}/${other.conversationId}`).set("Cookie", admin.cookie).send({ title: "hijack" })).status).toBe(404);
  });
});

describe("CV-03 delete conversations", () => {
  it("basic: deleting returns the remaining list", async () => {
    const extra = (await request(app).post(base()).set("Cookie", admin.cookie).send({ title: "Delete me" })).body;
    const res = await request(app).delete(`${base()}/${extra.id}`).set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id)).not.toContain(extra.id);
    const audit = await db.listAuditEvents(ws.id, { eventType: "conversation.deleted" });
    expect(audit.some((event) => event.summary.includes("Delete me") && event.actorUserId === admin.id)).toBe(true);
  });
  it("security: Editors cannot delete a conversation, even one they created", async () => {
    const own = (await request(app).post(base()).set("Cookie", editor.cookie).send({ title: "Editor chat" })).body;
    const res = await request(app).delete(`${base()}/${own.id}`).set("Cookie", editor.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Only Admins can delete/);
    expect(await db.getConversation(ws.id, own.id)).toBeTruthy();
  });
  it("edge: deleting the final conversation leaves one fresh blank conversation", async () => {
    const solo = await makeWorkspace(app, admin);
    const res = await request(app).delete(`/workspaces/${solo.id}/conversations/${solo.conversationId}`).set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).not.toBe(solo.conversationId);
  });
  it("edge: deleting twice is a 404", async () => {
    const extra = (await request(app).post(base()).set("Cookie", admin.cookie).send({})).body;
    await request(app).delete(`${base()}/${extra.id}`).set("Cookie", admin.cookie);
    expect((await request(app).delete(`${base()}/${extra.id}`).set("Cookie", admin.cookie)).status).toBe(404);
  });
});

describe("CV-04 message history", () => {
  it("basic: lists messages for a conversation in order", async () => {
    await db.insertMessage({ workspaceId: ws.id, conversationId: ws.conversationId, role: "user", userId: admin.id, authorName: "Admin", content: "first" });
    await db.insertMessage({ workspaceId: ws.id, conversationId: ws.conversationId, role: "user", userId: editor.id, authorName: "Editor", content: "second" });
    const res = await request(app).get(`/workspaces/${ws.id}/messages?conversationId=${ws.conversationId}`).set("Cookie", editor.cookie);
    expect(res.status).toBe(200);
    const texts = res.body.map((m: { content: string }) => m.content);
    expect(texts.indexOf("first")).toBeLessThan(texts.indexOf("second"));
  });
  it("edge: missing, malformed or foreign conversationId is a 400", async () => {
    const other = await makeWorkspace(app, outsider);
    for (const q of ["", "?conversationId=nope", `?conversationId=${other.conversationId}`]) {
      expect((await request(app).get(`/workspaces/${ws.id}/messages${q}`).set("Cookie", admin.cookie)).status).toBe(400);
    }
  });
  it("security: outsiders cannot read history", async () => {
    expect((await request(app).get(`/workspaces/${ws.id}/messages?conversationId=${ws.conversationId}`).set("Cookie", outsider.cookie)).status).toBe(403);
  });
});

describe("CV-05 activity log", () => {
  it("basic: records member and memory events with the actor's name", async () => {
    await request(app).post(`/workspaces/${ws.id}/memory`).set("Cookie", admin.cookie).send({ title: "Audit probe", content: "x" });
    const res = await request(app).get(`/workspaces/${ws.id}/audit`).set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.events.some((e: { summary: string }) => /Admin saved knowledge memory Audit probe/.test(e.summary))).toBe(true);
    expect(res.body.events.some((e: { eventType: string }) => e.eventType === "member.joined")).toBe(true);
  });
  it("edge: filters by type and text, paginates with before and clamps limits", async () => {
    const byType = await request(app).get(`/workspaces/${ws.id}/audit?type=memory.created`).set("Cookie", admin.cookie);
    expect(byType.body.events.every((e: { eventType: string }) => e.eventType === "memory.created")).toBe(true);
    const byText = await request(app).get(`/workspaces/${ws.id}/audit?q=audit%20PROBE`).set("Cookie", admin.cookie);
    expect(byText.body.events.length).toBeGreaterThan(0);
    const page = await request(app).get(`/workspaces/${ws.id}/audit?limit=1`).set("Cookie", admin.cookie);
    expect(page.body.events).toHaveLength(1);
    const older = await request(app).get(`/workspaces/${ws.id}/audit?limit=1&before=${encodeURIComponent(page.body.nextBefore)}`).set("Cookie", admin.cookie);
    expect(older.body.events[0]?.id).not.toBe(page.body.events[0].id);
    expect((await request(app).get(`/workspaces/${ws.id}/audit?limit=99999`).set("Cookie", admin.cookie)).status).toBe(200);
    expect((await request(app).get(`/workspaces/${ws.id}/audit?limit=-5`).set("Cookie", admin.cookie)).status).toBe(200);
  });
  it("edge: an invalid before timestamp is a 400, not a server error", async () => {
    expect((await request(app).get(`/workspaces/${ws.id}/audit?before=yesterday-ish`).set("Cookie", admin.cookie)).status).toBe(400);
  });
  it("edge: special characters in search are treated as text", async () => {
    for (const q of ["%", "_", "'; DROP TABLE users; --", "\\"]) {
      expect((await request(app).get(`/workspaces/${ws.id}/audit?q=${encodeURIComponent(q)}`).set("Cookie", admin.cookie)).status).toBe(200);
    }
  });
});
