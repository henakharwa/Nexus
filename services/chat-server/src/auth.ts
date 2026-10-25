// GitHub account authentication with database-backed, HTTP-only sessions.
// Login and repository integration share the registered /auth/github/callback
// URL. Login states use a distinct prefix and a browser-bound CSRF cookie.
// First sign-in creates the account; returning users reuse their GitHub identity.
import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import * as db from "@mai-chat/db";
import type { User } from "@mai-chat/shared-types";
import { registerEmailAuthRoutes } from "./email-auth.js";
import { registerGoogleAuthRoutes, type GoogleAuthConfig, type GoogleAuthDeps } from "./google-auth.js";
import { createMailer, defaultMailerConfig, type Mailer } from "./mailer.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Populated by attachUser below when a valid session cookie is
      // present; undefined otherwise. requireAuth is what actually
      // rejects a request that needs it but doesn't have one -- routes
      // that want to behave differently for signed-in vs anonymous
      // (there currently are none, everything requires auth) could check
      // this directly instead.
      user?: User;
    }
  }
}

const SESSION_COOKIE_NAME = "mai_session";
// 30 days -- long enough that "sign in once, stay signed in" holds for a
// real workspace tool people return to daily, short enough that a
// forgotten/lost device's session doesn't stay valid indefinitely. No
// refresh-on-use extension implemented -- it's a flat expiry from
// creation, simplest thing that works for Phase 2.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface UserAuthConfig {
  google?: GoogleAuthConfig;
  clientId: string;
  clientSecret: string;
  // Registered GitHub callback URL (shared with the integration in the app).
  redirectUri: string;
  // Where to send the browser back to once the flow finishes -- the
  // Next.js app's own origin, e.g. http://localhost:3000.
  webAppUrl: string;
  // true in a real (HTTPS) deployment, so the session cookie gets the
  // Secure attribute; false for local http:// dev, where Secure would
  // make the browser refuse to ever send the cookie at all.
  secureCookie: boolean;
  // Public path prefix through the reverse proxy. Locally the API is at
  // `/auth`; production Caddy publishes it under `/api/auth`.
  authCookiePath?: string;
  // Disabled for the public prototype until transactional email is set up.
  // Kept as a flag so verification can be restored without changing the
  // authentication flow again.
  emailVerificationEnabled?: boolean;
}

export interface UserAuthDeps {
  google?: GoogleAuthDeps;
  // Injectable so tests exercise the real route logic (state handling,
  // storing the user/session, error redirects) without hitting github.com
  // -- same "mock only the external network call" line as every other
  // OAuth flow in this project.
  exchangeCodeForToken: (code: string, config: UserAuthConfig) => Promise<{ accessToken: string } | { error: string }>;
  fetchGithubUser: (
    accessToken: string
  ) => Promise<{ githubId: string; email: string; username: string; displayName: string; avatarUrl?: string } | { error: string }>;
}

async function defaultExchangeCodeForToken(code: string, config: UserAuthConfig): Promise<{ accessToken: string } | { error: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    return { error: body.error_description ?? body.error ?? `GitHub token exchange failed (HTTP ${res.status})` };
  }
  return { accessToken: body.access_token };
}

async function defaultFetchGithubUser(
  accessToken: string
): Promise<{ githubId: string; email: string; username: string; displayName: string; avatarUrl?: string } | { error: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      // GitHub's API requires a User-Agent on every request or it 403s --
      // found in github.ts/listRepositoriesForToken already, same
      // requirement here.
      "user-agent": "multiplayer-ai-chat-server",
    },
  });
  const body = (await res.json().catch(() => ({}))) as { id?: number; login?: string; name?: string | null; avatar_url?: string };
  if (!res.ok || body.id === undefined) {
    return { error: `Could not fetch the signed-in GitHub profile (HTTP ${res.status}).` };
  }
  const emailResponse = await fetch("https://api.github.com/user/emails", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "multiplayer-ai-chat-server" },
  });
  const emails = (await emailResponse.json().catch(() => [])) as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
  const verifiedEmail = emails.find((entry) => entry.primary && entry.verified)?.email ?? emails.find((entry) => entry.verified)?.email;
  if (!emailResponse.ok || !verifiedEmail) {
    return { error: "GitHub did not provide a verified email address. Add and verify an email in GitHub, then try again." };
  }
  return {
    githubId: String(body.id),
    email: verifiedEmail,
    username: body.login ?? String(body.id),
    displayName: body.name?.trim() || body.login || String(body.id),
    avatarUrl: body.avatar_url,
  };
}

export const defaultUserAuthDeps: UserAuthDeps = {
  exchangeCodeForToken: defaultExchangeCodeForToken,
  fetchGithubUser: defaultFetchGithubUser,
};

const STATE_TTL_MS = 10 * 60 * 1000;

// Only ever a same-origin relative path (validated below) -- never an
// absolute URL, which would turn this into an open redirect.
export function safeReturnTo(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") && !/[\\\r\n]/.test(raw) ? raw : "/";
}

function cookieAttributes(config: UserAuthConfig, maxAgeSeconds: number): string {
  const parts = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${maxAgeSeconds}`];
  if (config.secureCookie) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookie(res: Response, token: string, config: UserAuthConfig): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes(config, Math.floor(SESSION_TTL_MS / 1000))}`);
}

export async function issueSession(res: Response, userId: string, config: UserAuthConfig): Promise<void> {
  const session = await db.createSession(userId, SESSION_TTL_MS);
  setSessionCookie(res, session.token, config);
}

function clearSessionCookie(res: Response, config: UserAuthConfig): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; ${cookieAttributes(config, 0)}`);
}

// Express has no built-in cookie parsing -- req.headers.cookie is just
// the raw "a=1; b=2" header string. Hand-rolled rather than pulling in
// cookie-parser for the one cookie this app ever sets; see llm-client.ts's
// own comment on preferring a well-documented, easy-to-verify wire format
// over an SDK/dependency where the format itself is this simple.
//
// Takes the raw header string rather than a whole Request so it works
// for BOTH Express's Request.headers.cookie (attachUser below) and the
// plain Node IncomingMessage a WebSocket upgrade handshake hands
// server.ts -- ws's "connection" event never goes through Express
// middleware at all, so that code parses the same header itself, this
// function is what it calls to do it.
export function parseSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      try { return decodeURIComponent(pair.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// Registered globally (before every route) -- populates req.user when a
// valid session cookie is present, but never rejects the request itself;
// requireAuth below is what actually enforces sign-in on the routes that
// need it. Splitting these lets a route (none currently, but the shape
// supports it) special-case "signed in vs not" without a hard 401.
export function attachUser(deps: { getUserBySessionToken: typeof db.getUserBySessionToken } = db) {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    const token = parseSessionToken(req.headers.cookie);
    if (!token) return next();
    try {
      req.user = (await deps.getUserBySessionToken(token)) ?? undefined;
    } catch {
      // A DB hiccup here shouldn't take the whole request down -- it just
      // behaves as if the user weren't signed in, and requireAuth (on
      // whatever route needed them) surfaces the normal 401.
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "sign in required" });
    return;
  }
  next();
}

export function registerUserAuthRoutes(
  app: Express,
  config: UserAuthConfig,
  deps: UserAuthDeps = defaultUserAuthDeps,
  // Injectable so tests never actually try to send mail -- the default
  // (createMailer with no RESEND_API_KEY) just prints to the console,
  // which is harmless in a test run.
  mailer: Mailer = createMailer(defaultMailerConfig())
): void {
  app.use("/auth", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.get("/auth/providers", (_req, res) => res.json({ email: true, github: !!(config.clientId && config.clientSecret), google: !!(config.google?.clientId && config.google.clientSecret) }));
  registerEmailAuthRoutes(app, config, mailer);
  registerGoogleAuthRoutes(app, config, deps.google);
  app.get("/auth/login/github/start", async (req: Request, res: Response) => {
    if (!config.clientId || !config.clientSecret) {
      return res
        .status(503)
        .json({ error: "Sign-in with GitHub isn't configured on this server (GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET are not set)." });
    }
    const state = `login:${randomUUID()}`;
    const returnTo = safeReturnTo(req.query.returnTo);
    const browserToken = randomUUID();
    await db.saveOAuthPendingState(state, "github-login", { returnTo, browserToken }, new Date(Date.now() + STATE_TTL_MS));
    res.cookie("mai_login_state", browserToken, { httpOnly: true, sameSite: "lax", secure: config.secureCookie, maxAge: STATE_TTL_MS, path: config.authCookiePath ?? "/auth" });

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
    // Request a verified email solely to link an existing account. GitHub's
    // stable numeric ID still authenticates future sign-ins.
    authorizeUrl.searchParams.set("scope", "user:email");
    authorizeUrl.searchParams.set("state", state);
    res.redirect(authorizeUrl.toString());
  });

  app.get(["/auth/login/github/callback", "/auth/github/callback"], async (req: Request, res: Response, next: NextFunction) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (req.path === "/auth/github/callback" && !state.startsWith("login:")) return next();
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";

    const pending = await db.consumeOAuthPendingState<{ returnTo: string; browserToken: string }>(state, "github-login");
    const browserToken = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("mai_login_state="))?.slice("mai_login_state=".length);
    res.clearCookie("mai_login_state", { path: config.authCookiePath ?? "/auth", httpOnly: true, sameSite: "lax", secure: config.secureCookie });

    function fail(message: string) {
      const url = new URL(pending?.returnTo ?? "/", config.webAppUrl);
      url.searchParams.set("loginError", message);
      res.redirect(url.toString());
    }

    if (oauthError) return fail(`GitHub said: ${oauthError}`);
    if (!pending) return fail("That sign-in link expired or was already used -- click Sign in with GitHub again.");
    if (browserToken !== pending.browserToken) return fail("Please start sign-in again in this browser.");
    if (!code) return fail("GitHub didn't send back an authorization code.");

    const tokenResult = await deps.exchangeCodeForToken(code, config);
    if ("error" in tokenResult) return fail(tokenResult.error);

    const profile = await deps.fetchGithubUser(tokenResult.accessToken);
    if ("error" in profile) return fail(profile.error);

    const user = await db.upsertUserFromGithub(profile);
    const session = await db.createSession(user.id, SESSION_TTL_MS);
    setSessionCookie(res, session.token, config);

    res.redirect(new URL(pending.returnTo, config.webAppUrl).toString());
  });

  // Lets the web app ask "who am I, if anyone" on load -- 401 (not a
  // 200 with a null body) when there's no valid session, so the client
  // can treat "signed in" as a simple res.ok check.
  app.get("/auth/me", (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "not signed in" });
    res.json(req.user);
  });

  // A person can inspect the sessions currently signed in to their account,
  // then sign out every other browser/device without losing this session.
  app.get("/auth/sessions", requireAuth, async (req: Request, res: Response) => {
    const token = parseSessionToken(req.headers.cookie);
    res.json({ sessions: await db.listSessionsForUser(req.user!.id, token) });
  });

  app.post("/auth/sessions/revoke-others", requireAuth, async (req: Request, res: Response) => {
    const token = parseSessionToken(req.headers.cookie);
    if (!token) return res.status(401).json({ error: "sign in required" });
    const revoked = await db.revokeOtherSessionsForUser(req.user!.id, token);
    res.json({ revoked });
  });

  app.post("/auth/logout", async (req: Request, res: Response) => {
    const token = parseSessionToken(req.headers.cookie);
    if (token) await db.deleteSession(token);
    // Personal tool connections end when the person is fully signed out.
    // Signing out of one browser or device used to remove them everywhere,
    // breaking the person's other sessions and any approvals waiting to run
    // with their connection, so only the last sign-out clears them.
    if (req.user && (await db.countActiveSessionsForUser(req.user.id)) === 0) {
      await db.deletePersonalIntegrationsForUser(req.user.id);
    }
    clearSessionCookie(res, config);
    res.status(204).end();
  });
}

// Exposed for tests only.
export const __testing = { SESSION_COOKIE_NAME, parseSessionToken };
