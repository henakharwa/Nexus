// Workspaces, join codes, invitations, membership and leaving.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, sentEmails, NIL_UUID, type TestUser } from "./helpers.js";

let admin: TestUser;
let editor: TestUser;
let outsider: TestUser;
const app = newApp();
beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin");
  editor = await makeUser("Editor");
  outsider = await makeUser("Outsider");
});
afterAll(async () => {
  await closePool();
});

describe("WS-01 create workspace", () => {
  it("basic: creates a workspace, makes the creator Admin and opens a first conversation", async () => {
    const ws = await makeWorkspace(app, admin);
    const access = await request(app).get(`/workspaces/${ws.id}/access`).set("Cookie", admin.cookie);
    expect(access.body.role).toBe("admin");
    expect(Object.values(access.body.permissions).every(Boolean)).toBe(true);
    expect(ws.conversationId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("edge: rejects a blank or whitespace-only name", async () => {
    for (const name of ["", "   ", undefined]) {
      expect((await request(app).post("/workspaces").set("Cookie", admin.cookie).send({ name })).status).toBe(400);
    }
  });
  it("edge: the same creator cannot reuse a name (case and spacing ignored); another user can", async () => {
    const name = `Dup Name ${Date.now()}`;
    expect((await request(app).post("/workspaces").set("Cookie", admin.cookie).send({ name })).status).toBe(201);
    const again = await request(app)
      .post("/workspaces")
      .set("Cookie", admin.cookie)
      .send({ name: `  ${name.toUpperCase()}  ` });
    expect(again.status).toBe(409);
    expect(again.body.workspace.joinCode).toBeTruthy();
    expect((await request(app).post("/workspaces").set("Cookie", editor.cookie).send({ name })).status).toBe(201);
  });
  it("edge: keeps unicode and emoji names intact", async () => {
    const res = await request(app)
      .post("/workspaces")
      .set("Cookie", admin.cookie)
      .send({ name: `Équipe 🚀 ${Date.now()}` });
    expect(res.status).toBe(201);
    expect(res.body.name).toContain("Équipe 🚀");
  });
  it("security: requires a signed-in user", async () => {
    expect((await request(app).post("/workspaces").send({ name: "Anon" })).status).toBe(401);
    expect((await request(app).get("/workspaces")).status).toBe(401);
  });
});

describe("WS-02 list my workspaces", () => {
  it("basic: lists every workspace the user belongs to with their role and join code", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    const mine = await request(app).get("/workspaces").set("Cookie", editor.cookie);
    const entry = mine.body.find((w: { id: string }) => w.id === ws.id);
    expect(entry).toMatchObject({ role: "editor", joinCode: ws.joinCode });
  });
  it("edge: a brand-new user has an empty list", async () => {
    const fresh = await makeUser("Fresh");
    expect((await request(app).get("/workspaces").set("Cookie", fresh.cookie)).body).toEqual([]);
  });
});

describe("WS-03 join by code", () => {
  it("basic: joining adds the user as Editor and is idempotent", async () => {
    const ws = await makeWorkspace(app, admin);
    const joiner = await makeUser("Joiner");
    expect(
      (await request(app).post(`/workspaces/by-code/${ws.joinCode}/join`).set("Cookie", joiner.cookie)).status,
    ).toBe(200);
    expect(
      (await request(app).post(`/workspaces/by-code/${ws.joinCode}/join`).set("Cookie", joiner.cookie)).status,
    ).toBe(200);
    const members = await request(app).get(`/workspaces/${ws.id}/members`).set("Cookie", admin.cookie);
    expect(members.body.filter((m: { id: string }) => m.id === joiner.id)).toEqual([
      expect.objectContaining({ role: "editor" }),
    ]);
  });
  it("edge: an existing Admin keeps their role when using the code", async () => {
    const ws = await makeWorkspace(app, admin);
    await request(app).post(`/workspaces/by-code/${ws.joinCode}/join`).set("Cookie", admin.cookie);
    expect((await request(app).get(`/workspaces/${ws.id}/access`).set("Cookie", admin.cookie)).body.role).toBe("admin");
  });
  it("edge: an unknown code is a 404 with a clear message", async () => {
    const res = await request(app).post(`/workspaces/by-code/NOPE00/join`).set("Cookie", outsider.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/join code/i);
  });
  it("security: repeated wrong guesses are rate limited, but normal successful joins are not", async () => {
    const guesser = await makeUser("Guesser");
    let last = 0;
    for (let i = 0; i < 21; i++)
      last = (await request(app).post(`/workspaces/by-code/BAD${i}xx/join`).set("Cookie", guesser.cookie)).status;
    expect(last).toBe(429);
    const ws = await makeWorkspace(app, admin);
    const regular = await makeUser("Regular");
    for (let i = 0; i < 25; i++)
      expect(
        (await request(app).post(`/workspaces/by-code/${ws.joinCode}/join`).set("Cookie", regular.cookie)).status,
      ).toBe(200);
  });
  it("security: removing a member rotates the code, so a copied former code cannot restore access", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    const oldCode = ws.joinCode;
    expect(
      (await request(app).delete(`/workspaces/${ws.id}/members/${editor.id}`).set("Cookie", admin.cookie)).status,
    ).toBe(204);
    expect((await request(app).post(`/workspaces/by-code/${oldCode}/join`).set("Cookie", editor.cookie)).status).toBe(
      404,
    );
    const current = await request(app).get(`/workspaces/${ws.id}`).set("Cookie", admin.cookie);
    expect(current.body.joinCode).not.toBe(oldCode);
    expect(
      (await request(app).post(`/workspaces/by-code/${current.body.joinCode}/join`).set("Cookie", editor.cookie))
        .status,
    ).toBe(200);
  });
  it("basic: an Admin can require approval for join-code requests, then approve or deny them", async () => {
    const ws = await makeWorkspace(app, admin);
    const requester = await makeUser("Join requester");
    const denied = await makeUser("Denied requester");
    expect(
      (
        await request(app)
          .put(`/workspaces/${ws.id}/join-policy`)
          .set("Cookie", admin.cookie)
          .send({ approvalRequired: true })
      ).status,
    ).toBe(204);
    expect(
      (await request(app).post(`/workspaces/by-code/${ws.joinCode}/join`).set("Cookie", requester.cookie)).status,
    ).toBe(202);
    expect((await request(app).get(`/workspaces/${ws.id}`).set("Cookie", requester.cookie)).status).toBe(403);
    expect(
      (await request(app).post(`/workspaces/by-code/${ws.joinCode}/join`).set("Cookie", denied.cookie)).status,
    ).toBe(202);
    const pending = await request(app).get(`/workspaces/${ws.id}/join-requests`).set("Cookie", admin.cookie);
    const approvedRequest = pending.body.find((item: { userId: string }) => item.userId === requester.id);
    const deniedRequest = pending.body.find((item: { userId: string }) => item.userId === denied.id);
    expect(
      (
        await request(app)
          .post(`/workspaces/${ws.id}/join-requests/${approvedRequest.id}/approve`)
          .set("Cookie", admin.cookie)
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .post(`/workspaces/${ws.id}/join-requests/${deniedRequest.id}/deny`)
          .set("Cookie", admin.cookie)
      ).status,
    ).toBe(204);
    expect((await request(app).get(`/workspaces/${ws.id}`).set("Cookie", requester.cookie)).status).toBe(200);
    expect((await request(app).get(`/workspaces/${ws.id}`).set("Cookie", denied.cookie)).status).toBe(403);
  });
  it("security: only Admins can see or decide join-code requests", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect((await request(app).get(`/workspaces/${ws.id}/join-requests`).set("Cookie", editor.cookie)).status).toBe(
      403,
    );
    expect(
      (
        await request(app)
          .put(`/workspaces/${ws.id}/join-policy`)
          .set("Cookie", editor.cookie)
          .send({ approvalRequired: true })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).post(`/workspaces/${ws.id}/join-requests/${NIL_UUID}/approve`).set("Cookie", editor.cookie))
        .status,
    ).toBe(403);
  });
});

describe("WS-04 invitations", () => {
  it("basic: Admin invites by email, the email is sent, and the invitee accepts with the matching account", async () => {
    const ws = await makeWorkspace(app, admin);
    const invitee = await makeUser("Invitee");
    const res = await request(app)
      .post(`/workspaces/${ws.id}/invitations`)
      .set("Cookie", admin.cookie)
      .send({ email: invitee.email.toUpperCase(), role: "editor" });
    expect(res.status).toBe(201);
    const email = sentEmails.find((e) => e.to === invitee.email);
    expect(email?.text).toContain("invite=");
    const token = new URL(email!.text.match(/https?:\/\/\S+/)![0]).searchParams.get("invite");
    const accepted = await request(app)
      .post("/workspace-invitations/accept")
      .set("Cookie", invitee.cookie)
      .send({ token });
    expect(accepted.body.workspaceId).toBe(ws.id);
    expect((await request(app).get(`/workspaces/${ws.id}/access`).set("Cookie", invitee.cookie)).body.role).toBe(
      "editor",
    );
    expect(
      (await request(app).post("/workspace-invitations/accept").set("Cookie", invitee.cookie).send({ token })).status,
    ).toBe(404);
  });
  it("edge: rejects invalid email, invalid role and existing members", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect(
      (
        await request(app)
          .post(`/workspaces/${ws.id}/invitations`)
          .set("Cookie", admin.cookie)
          .send({ email: "not-an-email", role: "editor" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/workspaces/${ws.id}/invitations`)
          .set("Cookie", admin.cookie)
          .send({ email: "a@b.co", role: "owner" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/workspaces/${ws.id}/invitations`)
          .set("Cookie", admin.cookie)
          .send({ email: editor.email, role: "editor" })
      ).status,
    ).toBe(409);
  });
  it("edge: an invitation cannot be accepted by a different account", async () => {
    const ws = await makeWorkspace(app, admin);
    const target = `someone-${Date.now()}@example.test`;
    await request(app)
      .post(`/workspaces/${ws.id}/invitations`)
      .set("Cookie", admin.cookie)
      .send({ email: target, role: "admin" });
    const token = new URL(sentEmails.find((e) => e.to === target)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get(
      "invite",
    );
    const res = await request(app).post("/workspace-invitations/accept").set("Cookie", outsider.cookie).send({ token });
    expect(res.status).toBe(403);
  });
  it("edge: a failed email send does not leave a dangling invitation", async () => {
    const failing = newApp({
      mailer: {
        send: async () => {
          throw new Error("Gmail API token refresh failed: invalid_grant");
        },
      },
    });
    const ws = await makeWorkspace(failing, admin);
    const res = await request(failing)
      .post(`/workspaces/${ws.id}/invitations`)
      .set("Cookie", admin.cookie)
      .send({ email: "x@example.test", role: "editor" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/expired or been revoked/);
    expect((await request(failing).get(`/workspaces/${ws.id}/invitations`).set("Cookie", admin.cookie)).body).toEqual(
      [],
    );
  });
  it("security: Editors cannot invite, list or revoke invitations", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect(
      (
        await request(app)
          .post(`/workspaces/${ws.id}/invitations`)
          .set("Cookie", editor.cookie)
          .send({ email: "z@example.test", role: "editor" })
      ).status,
    ).toBe(403);
    expect((await request(app).get(`/workspaces/${ws.id}/invitations`).set("Cookie", editor.cookie)).status).toBe(403);
  });
});

describe("WS-05 members and roles", () => {
  it("basic: Admin promotes an Editor and demotes them again", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect(
      (
        await request(app)
          .patch(`/workspaces/${ws.id}/members/${editor.id}`)
          .set("Cookie", admin.cookie)
          .send({ role: "admin" })
      ).status,
    ).toBe(204);
    expect((await request(app).get(`/workspaces/${ws.id}/access`).set("Cookie", editor.cookie)).body.role).toBe(
      "admin",
    );
    expect(
      (
        await request(app)
          .patch(`/workspaces/${ws.id}/members/${editor.id}`)
          .set("Cookie", admin.cookie)
          .send({ role: "editor" })
      ).status,
    ).toBe(204);
  });
  it("basic: role changes and removals are recorded in the workspace activity log", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect(
      (
        await request(app)
          .patch(`/workspaces/${ws.id}/members/${editor.id}`)
          .set("Cookie", admin.cookie)
          .send({ role: "admin" })
      ).status,
    ).toBe(204);
    expect(
      (await request(app).delete(`/workspaces/${ws.id}/members/${editor.id}`).set("Cookie", admin.cookie)).status,
    ).toBe(204);
    const audit = await request(app).get(`/workspaces/${ws.id}/audit`).set("Cookie", admin.cookie);
    expect(audit.body.events.map((event: { eventType: string }) => event.eventType)).toEqual(
      expect.arrayContaining(["member.role_changed", "member.removed"]),
    );
  });
  it("edge: the last Admin cannot be demoted, removed or leave while others remain", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect(
      (
        await request(app)
          .patch(`/workspaces/${ws.id}/members/${admin.id}`)
          .set("Cookie", admin.cookie)
          .send({ role: "editor" })
      ).status,
    ).toBe(409);
    expect(
      (await request(app).delete(`/workspaces/${ws.id}/members/${admin.id}`).set("Cookie", admin.cookie)).status,
    ).toBe(409);
    expect((await request(app).delete(`/workspaces/${ws.id}/membership`).set("Cookie", admin.cookie)).status).toBe(409);
  });
  it("edge: a sole member Admin may leave", async () => {
    const solo = await makeUser("Solo");
    const ws = await makeWorkspace(app, solo);
    expect((await request(app).delete(`/workspaces/${ws.id}/membership`).set("Cookie", solo.cookie)).status).toBe(204);
  });
  it("edge: invalid role values and unknown members", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect(
      (
        await request(app)
          .patch(`/workspaces/${ws.id}/members/${editor.id}`)
          .set("Cookie", admin.cookie)
          .send({ role: "viewer" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch(`/workspaces/${ws.id}/members/${NIL_UUID}`)
          .set("Cookie", admin.cookie)
          .send({ role: "editor" })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/workspaces/${ws.id}/members/not-a-uuid`).set("Cookie", admin.cookie)).status,
    ).toBe(404);
  });
  it("security: an Editor cannot leave and must be removed by an Admin", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect((await request(app).delete(`/workspaces/${ws.id}/membership`).set("Cookie", editor.cookie)).status).toBe(
      403,
    );
    expect((await request(app).get(`/workspaces/${ws.id}`).set("Cookie", editor.cookie)).status).toBe(200);
    expect(
      (await request(app).delete(`/workspaces/${ws.id}/members/${editor.id}`).set("Cookie", admin.cookie)).status,
    ).toBe(204);
    expect((await request(app).get(`/workspaces/${ws.id}`).set("Cookie", editor.cookie)).status).toBe(403);
  });
  it("basic: an Admin can permanently delete a workspace", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect((await request(app).delete(`/workspaces/${ws.id}`).set("Cookie", editor.cookie)).status).toBe(403);
    expect((await request(app).delete(`/workspaces/${ws.id}`).set("Cookie", admin.cookie)).status).toBe(204);
    expect((await request(app).get(`/workspaces/${ws.id}`).set("Cookie", admin.cookie)).status).toBe(404);
  });
  it("security: Editors cannot change roles or remove members", async () => {
    const ws = await makeWorkspace(app, admin, [editor]);
    expect(
      (
        await request(app)
          .patch(`/workspaces/${ws.id}/members/${admin.id}`)
          .set("Cookie", editor.cookie)
          .send({ role: "editor" })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).delete(`/workspaces/${ws.id}/members/${admin.id}`).set("Cookie", editor.cookie)).status,
    ).toBe(403);
  });
});

describe("WS-06 workspace guard", () => {
  it("edge: malformed id 400, unknown 404, non-member 403, signed-out 401", async () => {
    const ws = await makeWorkspace(app, admin);
    expect((await request(app).get(`/workspaces/not-a-uuid`).set("Cookie", admin.cookie)).status).toBe(400);
    expect((await request(app).get(`/workspaces/${NIL_UUID}`).set("Cookie", admin.cookie)).status).toBe(404);
    expect((await request(app).get(`/workspaces/${ws.id}`).set("Cookie", outsider.cookie)).status).toBe(403);
    expect((await request(app).get(`/workspaces/${ws.id}`)).status).toBe(401);
  });
  it("security: every membership-management route refuses a valid workspace id from another workspace", async () => {
    const myWorkspace = await makeWorkspace(app, admin);
    const otherWorkspace = await makeWorkspace(app, editor);
    const forbidden = [
      request(app).get(`/workspaces/${otherWorkspace.id}/members`).set("Cookie", admin.cookie),
      request(app).get(`/workspaces/${otherWorkspace.id}/join-policy`).set("Cookie", admin.cookie),
      request(app)
        .put(`/workspaces/${otherWorkspace.id}/join-policy`)
        .set("Cookie", admin.cookie)
        .send({ approvalRequired: true }),
      request(app).get(`/workspaces/${otherWorkspace.id}/join-requests`).set("Cookie", admin.cookie),
      request(app)
        .post(`/workspaces/${otherWorkspace.id}/join-requests/${NIL_UUID}/approve`)
        .set("Cookie", admin.cookie),
      request(app)
        .patch(`/workspaces/${otherWorkspace.id}/members/${editor.id}`)
        .set("Cookie", admin.cookie)
        .send({ role: "editor" }),
      request(app).delete(`/workspaces/${otherWorkspace.id}/members/${editor.id}`).set("Cookie", admin.cookie),
      request(app).delete(`/workspaces/${otherWorkspace.id}/membership`).set("Cookie", admin.cookie),
      request(app).delete(`/workspaces/${otherWorkspace.id}`).set("Cookie", admin.cookie),
    ];
    for (const response of await Promise.all(forbidden)) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect((await request(app).get(`/workspaces/${myWorkspace.id}`).set("Cookie", admin.cookie)).status).toBe(200);
  });
});
