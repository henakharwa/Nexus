// GitHub OAuth login for a workspace's GitHub integration -- the "+ Add
// channel -> GitHub" flow in apps/web (see docs/spec.md's Phase 1 note:
// this replaces pasting a personal access token as the primary path; the
// pasted-token form on the Integrations settings page still works as a
// fallback for anyone who'd rather not grant OAuth access).
//
// Flow: GET .../oauth/start redirects the browser to github.com's consent
// screen -> GitHub redirects back to GET /auth/github/callback with a code
// -> we exchange it for a token and store it (encrypted, via
// db.saveGithubOAuthToken) -> redirect the browser back into the app so it
// can show the repo picker (GET .../repos, then POST .../repo in
// server.ts finalizes which one).
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import * as db from "@mai-chat/db";
import { listRepositoriesForToken as defaultListRepositoriesForToken } from "@mai-chat/integrations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  // Full URL to this server's own /auth/github/callback route -- must
  // match the "Authorization callback URL" registered on the GitHub OAuth
  // App exactly, or GitHub rejects the exchange.
  redirectUri: string;
  // Where to send the browser back to once the flow finishes (success or
  // error) -- the Next.js app's own origin, e.g. http://localhost:3000.
  webAppUrl: string;
}

export interface GithubOAuthDeps {
  // Injectable so tests exercise the real route logic (state handling,
  // storing the token, error redirects) without hitting github.com --
  // same "mock only the external network call" line as every other
  // package in this repo.
  exchangeCodeForToken: (
    code: string,
    config: GithubOAuthConfig,
  ) => Promise<{ accessToken: string } | { error: string }>;
  listRepositoriesForToken: typeof defaultListRepositoriesForToken;
}

async function defaultExchangeCodeForToken(
  code: string,
  config: GithubOAuthConfig,
): Promise<{ accessToken: string } | { error: string }> {
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      return { error: body.error_description ?? body.error ?? `GitHub token exchange failed (HTTP ${res.status})` };
    }
    return { accessToken: body.access_token };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "GitHub took too long to respond. Please try again."
          : "GitHub could not be reached. Please try again.",
    };
  }
}

export const defaultGithubOAuthDeps: GithubOAuthDeps = {
  exchangeCodeForToken: defaultExchangeCodeForToken,
  listRepositoriesForToken: defaultListRepositoriesForToken,
};

const STATE_TTL_MS = 10 * 60 * 1000;

function redirectTarget(
  config: GithubOAuthConfig,
  workspaceId: string | undefined,
  status: "connected" | "error",
  message?: string,
): string {
  const url = new URL(workspaceId ? `/w/${workspaceId}` : "/", config.webAppUrl);
  url.searchParams.set("github", status);
  if (message) url.searchParams.set("githubMessage", message);
  return url.toString();
}

export function registerGithubOAuthRoutes(
  app: Express,
  config: GithubOAuthConfig,
  deps: GithubOAuthDeps = defaultGithubOAuthDeps,
): void {
  app.get("/workspaces/:id/integrations/github/oauth/start", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role || !(await db.hasWorkspacePermissionForUser(workspaceId, role, req.user!.id, "connectTools")))
      return res.status(403).json({ error: "You do not have permission to connect this tool." });
    if (!config.clientId || !config.clientSecret) {
      return res
        .status(503)
        .json({
          error:
            "GitHub login isn't configured on this server (GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET are not set).",
        });
    }

    const state = randomUUID();
    await db.saveOAuthPendingState(
      state,
      "github-integration",
      { workspaceId, userId: req.user!.id },
      new Date(Date.now() + STATE_TTL_MS),
    );

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
    authorizeUrl.searchParams.set("scope", "repo");
    authorizeUrl.searchParams.set("state", state);
    res.redirect(authorizeUrl.toString());
  });

  app.get("/auth/github/callback", async (req: Request, res: Response) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";

    const pending = await db.consumeOAuthPendingState<{ workspaceId: string; userId: string }>(
      state,
      "github-integration",
    );

    if (oauthError) {
      return res.redirect(redirectTarget(config, pending?.workspaceId, "error", `GitHub said: ${oauthError}`));
    }
    if (!pending) {
      return res.redirect(
        redirectTarget(
          config,
          undefined,
          "error",
          "That GitHub login link expired or was already used -- click Connect GitHub again.",
        ),
      );
    }
    // The token is saved for whoever started this flow, so only that same
    // signed-in session may finish it. Otherwise someone could start a
    // connection and send the provider's link to another person, whose
    // account would then be stored as theirs.
    if (req.user?.id !== pending.userId) {
      return res.redirect(
        redirectTarget(
          config,
          pending.workspaceId,
          "error",
          "Please finish connecting in the same browser and account you started from.",
        ),
      );
    }
    if (!code) {
      return res.redirect(
        redirectTarget(config, pending.workspaceId, "error", "GitHub didn't send back an authorization code."),
      );
    }

    const result = await deps.exchangeCodeForToken(code, config);
    if ("error" in result) {
      return res.redirect(redirectTarget(config, pending.workspaceId, "error", result.error));
    }

    await db.saveGithubOAuthToken({
      workspaceId: pending.workspaceId,
      token: result.accessToken,
      ownerUserId: pending.userId,
    });
    if (req.user) {
      await db.recordAuditEvent({
        workspaceId: pending.workspaceId,
        eventType: "integration.connected",
        actorType: "user",
        actorUserId: req.user.id,
        actorName: req.user.displayName,
        summary: `${req.user.displayName} connected GitHub`,
        metadata: { integration: "github" },
      });
    }
    res.redirect(redirectTarget(config, pending.workspaceId, "connected"));
  });

  app.get("/workspaces/:id/integrations/github/repos", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    const integration = (await db.listIntegrations(workspaceId)).find(
      (candidate) => candidate.type === "github" && candidate.ownerUserId === req.user!.id,
    );
    const credential = integration ? await db.getIntegrationCredential(workspaceId, "github", integration.id) : null;
    if (!credential) return res.status(404).json({ error: "GitHub isn't connected for this workspace yet." });
    try {
      const repos = await deps.listRepositoriesForToken(credential.token);
      res.json(repos);
    } catch (err) {
      res
        .status(502)
        .json({ error: `could not list GitHub repositories: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
