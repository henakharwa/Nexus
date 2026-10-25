import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { runMigrations } from "@mai-chat/db";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import express from "express";
import request from "supertest";
import * as db from "@mai-chat/db";
import { attachUser, registerUserAuthRoutes, requireAuth, type UserAuthConfig, type UserAuthDeps } from "../src/auth.js";
import { defaultGoogleAuthDeps } from "../src/google-auth.js";
import { hashPassword, verifyPassword } from "../src/passwords.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const config: UserAuthConfig = {
  clientId: "github-test", clientSecret: "test", redirectUri: "http://localhost:4000/auth/github/callback",
  webAppUrl: "http://localhost:3000", secureCookie: false,
  google: { clientId: "google-test", clientSecret: "secret", redirectUri: "http://localhost:4000/auth/login/google/callback" },
};
function makeApp(overrides: Partial<UserAuthDeps> = {}, authConfig = config) {
  const app = express();
  app.use(express.json()); app.use(attachUser());
  registerUserAuthRoutes(app, authConfig, {
    exchangeCodeForToken: async () => ({ error: "unused" }), fetchGithubUser: async () => ({ error: "unused" }),
    google: { fetchProfile: async () => ({ googleId: "google-test-user", email: "google@example.test", displayName: "Google Member" }) },
    ...overrides,
  });
  app.get("/protected", requireAuth, (req, res) => res.json(req.user));
  return app;
}
beforeAll(async () => {
  await runMigrations();
  // Sign-in limits are stored in the database; start each run with a clean slate.
  await db.getPool().query("DELETE FROM auth_rate_limits WHERE scope LIKE 'email-auth-%'");
});
afterAll(async () => { await db.closePool(); });
const newAccount = () => ({ email: `${randomUUID()}@example.test`, password: `Test-${randomUUID()}`, displayName: "Email Member" });

describe("email account authentication", () => {
  it("creates a persisted account, signs out and back in, and never exposes the password hash", async () => {
    const app = makeApp(); const browser = request.agent(app); const account = newAccount();
    const signup = await browser.post("/auth/signup/email").send(account);
    expect(signup.status).toBe(201);
    expect(signup.body.githubId).toBeNull();
    expect(JSON.stringify(signup.body)).not.toContain(account.password);
    expect(JSON.stringify(signup.body)).not.toContain("passwordHash");
    const stored = await db.getPasswordCredential(account.email);
    expect(stored?.passwordHash).toMatch(/^scrypt\$/);
    expect(stored?.passwordHash).not.toContain(account.password);
    expect((await browser.get("/protected")).status).toBe(200);
    await browser.post("/auth/logout");
    expect((await browser.get("/protected")).status).toBe(401);
    const login = await browser.post("/auth/login/email").send({ email: ` ${account.email.toUpperCase()} `, password: account.password });
    expect(login.status).toBe(200); expect(login.body.id).toBe(signup.body.id);
    expect((await browser.get("/auth/me")).body.displayName).toBe("Email Member");
  });
  it("rejects duplicates atomically without creating an orphan account", async () => {
    const app = makeApp(); const account = newAccount();
    await request(app).post("/auth/signup/email").send(account);
    const duplicate = await request(app).post("/auth/signup/email").send({ ...account, email: account.email.toUpperCase() });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toBe("Unable to create an account. Check your details and try again.");
    expect((await db.getPool().query("SELECT count(*) FROM users WHERE username = $1", [account.email])).rows[0].count).toBe("1");
  });
  // Unknown and incorrect credentials must be indistinguishable to avoid
  // exposing whether an email address has an account.
  it("rejects an unknown email and a wrong password without signing in", async () => {
    const app = makeApp(); const account = newAccount();
    await request(app).post("/auth/signup/email").send(account);
    const wrong = await request(app).post("/auth/login/email").send({ ...account, password: "wrong" });
    const unknown = await request(app).post("/auth/login/email").send(newAccount());
    expect(wrong.status).toBe(401); expect(unknown.status).toBe(401);
    expect(wrong.body.error).toBe("Invalid email or password.");
    expect(unknown.body.error).toBe("Invalid email or password.");
    expect(wrong.headers["set-cookie"]).toBeUndefined(); expect(unknown.headers["set-cookie"]).toBeUndefined();
  });
  it("validates credentials and rejects cross-origin login and non-JSON forms", async () => {
    const app = makeApp(); const account = newAccount();
    for (const changes of [{ password: "short" }, { email: "invalid" }, { displayName: "" }, { password: "a".repeat(129) }]) {
      expect((await request(app).post("/auth/signup/email").send({ ...account, ...changes })).status).toBe(400);
    }
    expect((await request(app).post("/auth/login/email").set("Origin", "https://evil.example").send(account)).status).toBe(403);
    expect((await request(app).post("/auth/login/email").type("form").send(account)).status).toBe(403);
  });
  it("throttles repeated login attempts", async () => {
    const app = makeApp(); const account = newAccount();
    for (let i = 0; i < 10; i++) await request(app).post("/auth/login/email").send({ email: account.email, password: "" });
    const blocked = await request(app).post("/auth/login/email").send(account);
    expect(blocked.status).toBe(429); expect(blocked.headers["retry-after"]).toBe("900");
  });
  it("uses unique salts and verifies only the correct password", async () => {
    const password = newAccount().password;
    const first = await hashPassword(password); const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword("incorrect", first)).toBe(false);
  });
});

describe("Google sign-in", () => {
  it("uses browser-bound state and PKCE and reuses the Google account on subsequent logins", async () => {
    const profile = vi.fn(async () => ({ googleId: randomUUID(), email: "google@example.test", displayName: "Google Member" }));
    const googleId = randomUUID(); profile.mockResolvedValue({ googleId, email: "google@example.test", displayName: "Google Member" });
    const app = makeApp({ google: { fetchProfile: profile } }); const browser = request.agent(app);
    let userId: string | undefined;
    for (let i = 0; i < 2; i++) {
      const start = await browser.get("/auth/login/google/start").query({ returnTo: "/?joinCode=team" });
      const url = new URL(start.headers.location);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("scope")).toBe("openid email profile");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = await browser.get("/auth/login/google/callback").query({ state: url.searchParams.get("state"), code: "test-code" });
      expect(callback.headers.location).toBe("http://localhost:3000/?joinCode=team");
      const verifier = profile.mock.calls[i][1];
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
      const me = await browser.get("/auth/me"); expect(me.status).toBe(200);
      if (userId) expect(me.body.id).toBe(userId); userId = me.body.id;
      const replay = await browser.get("/auth/login/google/callback").query({ state: url.searchParams.get("state"), code: "test-code" });
      expect(replay.headers.location).toContain("loginError");
    }
  });
  it("rejects copied state and denied consent without creating a session", async () => {
    const profile = vi.fn(); const app = makeApp({ google: { fetchProfile: profile } }); const browser = request.agent(app);
    const start = await browser.get("/auth/login/google/start");
    const state = new URL(start.headers.location).searchParams.get("state");
    const cross = await request(app).get("/auth/login/google/callback").query({ state, code: "test" });
    expect(cross.headers.location).toContain("loginError"); expect(profile).not.toHaveBeenCalled();
    const next = await browser.get("/auth/login/google/start");
    const denied = await browser.get("/auth/login/google/callback").query({ state: new URL(next.headers.location).searchParams.get("state"), error: "access_denied" });
    expect(denied.headers.location).toContain("cancelled"); expect(profile).not.toHaveBeenCalled();
  });
  it("reports missing configuration and sanitizes external redirects", async () => {
    const app = makeApp({}, { ...config, google: undefined });
    expect((await request(app).get("/auth/providers")).body).toEqual({ email: true, google: false, github: true });
    const start = await request(app).get("/auth/login/google/start").query({ returnTo: "https://evil.example" });
    expect(new URL(start.headers.location).origin).toBe(config.webAppUrl);
    expect(start.headers.location).toContain("loginError");
  });
  it("does not link a Google identity to an unverified password account by email", async () => {
    const account = newAccount(); const app = makeApp({ google: { fetchProfile: async () => ({ googleId: randomUUID(), email: account.email, displayName: "Google" }) } }, { ...config, emailVerificationEnabled: true });
    const created = await request(app).post("/auth/signup/email").send(account);
    const browser = request.agent(app); const start = await browser.get("/auth/login/google/start");
    await browser.get("/auth/login/google/callback").query({ code: "test", state: new URL(start.headers.location).searchParams.get("state") });
    expect((await browser.get("/auth/me")).body.id).not.toBe(created.body.id);
  });
  // Security regression: with verification disabled, a sign-up used to be
  // treated as a verified email, so someone could pre-register a victim's
  // address and later receive the victim's Google sign-in.
  it("does not hand a Google login to a password account that merely typed the same email", async () => {
    const account = newAccount();
    const app = makeApp({ google: { fetchProfile: async () => ({ googleId: randomUUID(), email: account.email, displayName: "Google" }) } });
    const created = await request(app).post("/auth/signup/email").send(account);
    expect(created.status).toBe(201);
    expect(created.body.emailVerified).toBe(false);
    const browser = request.agent(app); const start = await browser.get("/auth/login/google/start");
    await browser.get("/auth/login/google/callback").query({ code: "test", state: new URL(start.headers.location).searchParams.get("state") });
    expect((await browser.get("/auth/me")).body.id).not.toBe(created.body.id);
  });
  // Security regression: a password sign-up on an email that a Google/GitHub
  // account already owns used to attach a new password to that account and
  // sign the stranger in as its owner.
  it("refuses an email sign-up for an address a Google or GitHub account already owns", async () => {
    // Checked at the database layer: the sign-up route turns this refusal
    // into its usual 409 without issuing a session (see "rejects duplicates
    // atomically" above), and staying off HTTP keeps this test out of the
    // per-IP sign-in rate limit that the other files running in parallel share.
    const googleVictim = await db.upsertUserFromGoogle({ googleId: randomUUID(), email: `${randomUUID()}@gmail.test`, displayName: "Victim" });
    const githubVictim = await db.upsertUserFromGithub({ githubId: randomUUID(), email: `${randomUUID()}@github.test`, username: `v-${randomUUID().slice(0, 8)}`, displayName: "Victim" });
    for (const victim of [googleVictim, githubVictim]) {
      await expect(db.createPasswordUser({ email: victim.email!, displayName: "Mallory", passwordHash: "x" })).rejects.toMatchObject({ code: "23505" });
      expect(await db.getPasswordCredential(victim.email!)).toBeNull();
    }
  });
  it("validates the real token and UserInfo responses", async () => {
    const mocked = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-access" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "google-sub", email: "member@example.test", email_verified: true, name: "Member" })));
    vi.stubGlobal("fetch", mocked);
    try {
      expect((await defaultGoogleAuthDeps.fetchProfile("code", "verifier", config.google!)).googleId).toBe("google-sub");
      expect(mocked.mock.calls[0][1].body.get("code_verifier")).toBe("verifier");
      expect(mocked.mock.calls[1][1].headers.authorization).toBe("Bearer test-access");
      mocked.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test" })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "sub", email: "e@example.test", email_verified: false })));
      await expect(defaultGoogleAuthDeps.fetchProfile("code", "verifier", config.google!)).rejects.toThrow("verify");
    } finally { vi.unstubAllGlobals(); }
  });
});
