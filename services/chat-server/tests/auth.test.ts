import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runMigrations } from "@mai-chat/db";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import express from "express";
import supertest from "supertest";
const agents = new WeakMap<express.Express, ReturnType<typeof supertest.agent>>();
function request(app: express.Express) {
  if (!agents.has(app)) agents.set(app, supertest.agent(app));
  return agents.get(app)!;
}
import { getPool, closePool, createSession, getUserBySessionToken, pruneExpiredSessions } from "@mai-chat/db";
import {
  registerUserAuthRoutes,
  attachUser,
  requireAuth,
  type UserAuthConfig,
  type UserAuthDeps,
} from "../src/auth.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

// Real Express app, real local Postgres -- same "mock only the external
// network call" line every OAuth suite in this project draws (see
// slack-oauth.test.ts). The only things mocked here are
// exchangeCodeForToken and fetchGithubUser, standing in for the two real
// HTTPS calls to github.com/api.github.com -- this suite locks in
// everything AROUND those calls: state handling, cookie issuance, error
// redirects, and attachUser/requireAuth's actual gating behavior.

const config: UserAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:4000/auth/login/github/callback",
  webAppUrl: "http://localhost:3000",
  secureCookie: false,
};

function makeApp(deps: UserAuthDeps) {
  const app = express();
  app.use(express.json());
  app.use(attachUser());
  registerUserAuthRoutes(app, config, deps);
  // A stand-in protected route, the same way server.ts gates everything
  // under /workspaces -- lets this suite verify requireAuth's actual
  // pass/reject behavior without depending on the rest of the app.
  app.get("/protected", requireAuth, (req, res) => res.json({ ok: true, userId: req.user!.id }));
  return app;
}

const okDeps: UserAuthDeps = {
  exchangeCodeForToken: async () => ({ accessToken: "gho_real-token" }),
  fetchGithubUser: async () => ({
    githubId: "12345",
    email: "octocat@example.test",
    username: "octocat",
    displayName: "The Octocat",
    avatarUrl: "https://example.com/a.png",
  }),
};

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await closePool();
});

function extractCookie(res: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) throw new Error("response had no Set-Cookie header");
  return header.split(";")[0];
}

describe("GET /auth/login/github/start", () => {
  it("redirects to GitHub's authorize endpoint with client_id, redirect_uri, state, and email scope", async () => {
    const app = makeApp(okDeps);
    const res = await request(app).get("/auth/login/github/start");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("scope")).toBe("user:email");
  });

  it("honors a relative returnTo, but ignores an absolute/external one (open-redirect protection)", async () => {
    const app = makeApp(okDeps);
    const relative = await request(app).get("/auth/login/github/start").query({ returnTo: "/w/abc-123" });
    const relativeState = new URL(relative.headers.location).searchParams.get("state")!;

    const externalApp = makeApp(okDeps);
    const external = await request(externalApp)
      .get("/auth/login/github/start")
      .query({ returnTo: "https://evil.example/steal" });
    const externalState = new URL(external.headers.location).searchParams.get("state")!;

    const relativeCallback = await request(app)
      .get("/auth/login/github/callback")
      .query({ code: "c1", state: relativeState });
    expect(new URL(relativeCallback.headers.location).pathname).toBe("/w/abc-123");

    const externalCallback = await request(externalApp)
      .get("/auth/login/github/callback")
      .query({ code: "c2", state: externalState });
    const externalLocation = new URL(externalCallback.headers.location);
    expect(externalLocation.origin).toBe(config.webAppUrl);
    expect(externalLocation.pathname).toBe("/");
  });

  it("503s when sign-in with GitHub isn't configured on this server", async () => {
    const app = express();
    app.use(express.json());
    app.use(attachUser());
    registerUserAuthRoutes(app, { ...config, clientId: "", clientSecret: "" }, okDeps);
    const res = await request(app).get("/auth/login/github/start");
    expect(res.status).toBe(503);
  });
});

describe("GET /auth/login/github/callback", () => {
  it("rejects a valid state copied into a different browser", async () => {
    const app = makeApp(okDeps);
    const start = await request(app).get("/auth/login/github/start");
    const state = new URL(start.headers.location).searchParams.get("state")!;
    const callback = await supertest(app).get("/auth/login/github/callback").query({ code: "code", state });
    expect(new URL(callback.headers.location).searchParams.get("loginError")).toContain("this browser");
    expect(String(callback.headers["set-cookie"])).not.toContain("mai_session=");
  });

  it("rejects redirect paths containing backslashes", async () => {
    const app = makeApp(okDeps);
    const start = await request(app).get("/auth/login/github/start").query({ returnTo: "/\\evil.example" });
    const state = new URL(start.headers.location).searchParams.get("state")!;
    const callback = await request(app).get("/auth/login/github/callback").query({ code: "code", state });
    expect(callback.headers.location).toBe(`${config.webAppUrl}/`);
  });
  async function startFlow(app: ReturnType<typeof makeApp>): Promise<string> {
    const startRes = await request(app).get("/auth/login/github/start");
    return new URL(startRes.headers.location).searchParams.get("state")!;
  }

  it("on success, upserts the user, mints a session, sets an httpOnly cookie, and redirects to returnTo (default /)", async () => {
    const app = makeApp(okDeps);
    const state = await startFlow(app);

    const res = await request(app).get("/auth/login/github/callback").query({ code: "good-code", state });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).pathname).toBe("/");

    const cookieHeader =
      (Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"][0] : res.headers["set-cookie"]) ?? "";
    expect(cookieHeader).toContain("mai_session=");
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).not.toMatch(/Secure/i); // secureCookie: false in this config

    const cookie = extractCookie(res);
    const me = await request(app).get("/protected").set("Cookie", cookie);
    expect(me.status).toBe(200);
  });

  it("upserting the same GitHub id twice reuses one user row (sign in, sign out, sign in again)", async () => {
    const app = makeApp(okDeps);
    const state1 = await startFlow(app);
    const first = await request(app).get("/auth/login/github/callback").query({ code: "c1", state: state1 });
    const firstMe = await request(app).get("/protected").set("Cookie", extractCookie(first));

    const state2 = await startFlow(app);
    const second = await request(app).get("/auth/login/github/callback").query({ code: "c2", state: state2 });
    const secondMe = await request(app).get("/protected").set("Cookie", extractCookie(second));

    expect(firstMe.body.userId).toBe(secondMe.body.userId);
  });

  it("redirects with a loginError and stores nothing when the token exchange fails", async () => {
    const app = makeApp({ ...okDeps, exchangeCodeForToken: async () => ({ error: "bad_verification_code" }) });
    const state = await startFlow(app);

    const res = await request(app).get("/auth/login/github/callback").query({ code: "bad-code", state });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get("loginError")).toBe("bad_verification_code");
    expect(String(res.headers["set-cookie"])).not.toContain("mai_session=");
  });

  it("redirects with a loginError when fetching the GitHub profile fails", async () => {
    const app = makeApp({ ...okDeps, fetchGithubUser: async () => ({ error: "profile fetch failed" }) });
    const state = await startFlow(app);

    const res = await request(app).get("/auth/login/github/callback").query({ code: "good-code", state });
    const location = new URL(res.headers.location);
    expect(location.searchParams.get("loginError")).toBe("profile fetch failed");
  });

  it("redirects with a loginError when GitHub itself reports one (e.g. the user denied consent)", async () => {
    const app = makeApp(okDeps);
    const state = await startFlow(app);

    const res = await request(app).get("/auth/login/github/callback").query({ state, error: "access_denied" });
    const location = new URL(res.headers.location);
    expect(location.searchParams.get("loginError")).toContain("access_denied");
  });

  it("rejects a state that's already been used (single-use CSRF protection)", async () => {
    const app = makeApp(okDeps);
    const state = await startFlow(app);

    await request(app).get("/auth/login/github/callback").query({ code: "code", state });
    const replay = await request(app).get("/auth/login/github/callback").query({ code: "code", state });
    const location = new URL(replay.headers.location);
    expect(location.searchParams.get("loginError")).toContain("expired or was already used");
  });

  it("rejects an unknown/missing state the same way", async () => {
    const app = makeApp(okDeps);
    const res = await request(app)
      .get("/auth/login/github/callback")
      .query({ code: "code", state: "not-a-real-state" });
    const location = new URL(res.headers.location);
    expect(location.searchParams.get("loginError")).toContain("expired or was already used");
  });
});

describe("attachUser / requireAuth", () => {
  it("treats malformed and expired session cookies as signed out", async () => {
    const app = makeApp(okDeps);
    expect((await request(app).get("/protected").set("Cookie", "mai_session=%ZZ")).status).toBe(401);
    const { upsertUserFromGithub, createSession } = await import("@mai-chat/db");
    const user = await upsertUserFromGithub({ githubId: "expired-test", username: "expired", displayName: "Expired" });
    const session = await createSession(user.id, -1000);
    expect((await request(app).get("/protected").set("Cookie", `mai_session=${session.token}`)).status).toBe(401);
  });
  it("GET /protected 401s with no cookie, 401s with a garbage cookie, and passes through with a valid one", async () => {
    const app = makeApp(okDeps);

    const noCookie = await request(app).get("/protected");
    expect(noCookie.status).toBe(401);

    const garbage = await request(app).get("/protected").set("Cookie", "mai_session=not-a-real-token");
    expect(garbage.status).toBe(401);

    const startRes = await request(app).get("/auth/login/github/start");
    const state = new URL(startRes.headers.location).searchParams.get("state")!;
    const callback = await request(app).get("/auth/login/github/callback").query({ code: "good-code", state });
    const cookie = extractCookie(callback);
    const good = await request(app).get("/protected").set("Cookie", cookie);
    expect(good.status).toBe(200);
    expect(good.body.ok).toBe(true);
  });
});

describe("GET /auth/me", () => {
  it("401s when not signed in, returns the user's own profile when signed in", async () => {
    const app = makeApp(okDeps);
    const anon = await request(app).get("/auth/me");
    expect(anon.status).toBe(401);

    const startRes = await request(app).get("/auth/login/github/start");
    const state = new URL(startRes.headers.location).searchParams.get("state")!;
    const callback = await request(app).get("/auth/login/github/callback").query({ code: "good-code", state });
    const cookie = extractCookie(callback);

    const me = await request(app).get("/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("octocat");
    expect(me.body.displayName).toBe("The Octocat");
  });
});

describe("session management", () => {
  it("lists sessions without exposing tokens, signs out other devices, and prunes expired records", async () => {
    const app = makeApp({
      ...okDeps,
      fetchGithubUser: async () => ({
        githubId: `sessions-${Date.now()}`,
        email: `sessions-${Date.now()}@example.test`,
        username: "sessions",
        displayName: "Sessions",
      }),
    });
    const start = await request(app).get("/auth/login/github/start");
    const callback = await request(app)
      .get("/auth/login/github/callback")
      .query({ code: "good-code", state: new URL(start.headers.location).searchParams.get("state") });
    const cookie = extractCookie(callback);
    const currentToken = cookie.split("=")[1];
    const currentUser = await getUserBySessionToken(currentToken);
    expect(currentUser).not.toBeNull();
    const expired = await createSession(currentUser!.id, -1_000);
    // Cleanup is deliberately out of the request path. Prove the scheduled
    // worker's DB operation removes an expired record before session revocation
    // is measured, otherwise revoke-others correctly counts the expired row.
    expect(await pruneExpiredSessions()).toBeGreaterThanOrEqual(1);
    expect(await getUserBySessionToken(expired.token)).toBeNull();
    const other = await createSession(currentUser!.id, 60_000);

    const listed = await request(app).get("/auth/sessions").set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(2);
    expect(listed.body.sessions.filter((session: { current: boolean }) => session.current)).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(currentToken);
    expect(JSON.stringify(listed.body)).not.toContain(other.token);

    const revoked = await request(app).post("/auth/sessions/revoke-others").set("Cookie", cookie);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: 1 });
    expect(await getUserBySessionToken(other.token)).toBeNull();
    expect(await getUserBySessionToken(currentToken)).not.toBeNull();

    const another = await createSession(currentUser!.id, 60_000);
    const revokeAll = await request(app).post("/auth/sessions/revoke-all").set("Cookie", cookie);
    expect(revokeAll.status).toBe(204);
    expect(String(revokeAll.headers["set-cookie"])).toContain("Max-Age=0");
    expect(await getUserBySessionToken(currentToken)).toBeNull();
    expect(await getUserBySessionToken(another.token)).toBeNull();
  });
});

describe("POST /auth/logout", () => {
  it("clears the cookie and revokes the underlying session", async () => {
    const app = makeApp(okDeps);
    const startRes = await request(app).get("/auth/login/github/start");
    const state = new URL(startRes.headers.location).searchParams.get("state")!;
    const callback = await request(app).get("/auth/login/github/callback").query({ code: "good-code", state });
    const cookie = extractCookie(callback);
    const rawToken = cookie.split("=")[1];

    expect(await getUserBySessionToken(rawToken)).not.toBeNull();

    const logout = await request(app).post("/auth/logout").set("Cookie", cookie);
    expect(logout.status).toBe(204);

    expect(await getUserBySessionToken(rawToken)).toBeNull();

    const meAfter = await request(app).get("/auth/me").set("Cookie", cookie);
    expect(meAfter.status).toBe(401);
  });
});
