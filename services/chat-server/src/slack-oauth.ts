// Slack OAuth login for a workspace's Slack integration -- the ONLY way to
// connect Slack now that its tools come from Slack's own official MCP
// server (see slack-mcp-pool.ts) instead of the hand-rolled
// packages/integrations/src/slack.ts client this replaces. Unlike GitHub
// (which kept a pasted-personal-access-token fallback alongside its OAuth
// login, because GitHub's MCP server accepts any valid token in
// GITHUB_PERSONAL_ACCESS_TOKEN, OAuth-issued or not -- see
// github-oauth.ts), there is no pasted-token fallback for Slack: Slack's
// MCP server only accepts a *user* access token minted by this exact
// OAuth flow against a specific registered Slack App, so a hand-pasted
// bot token (what the old /workspaces/:id/integrations/slack route
// accepted) could never authenticate to it.
//
// Flow: GET .../oauth/start redirects the browser to slack.com's consent
// screen -> Slack redirects back to GET /auth/slack/callback with a code
// -> we exchange it for a user access token and store it (encrypted, via
// db.upsertSlackIntegration) -> redirect the browser back into the app.
// No repo-picker-style second step -- unlike GitHub, Slack's token is
// already scoped to one team/workspace as soon as the OAuth grant
// completes, so there's nothing further to choose.
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import * as db from "@mai-chat/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// Slack's user-token-only OAuth endpoints, specifically for apps (like
// this one) that need a real user identity rather than a separate bot
// user -- required by Slack's MCP server, see
// docs.slack.dev/ai/slack-mcp-server/. Distinct from Slack's older,
// better-known oauth.v2.authorize / oauth.v2.access pair (which mint a
// bot token, optionally alongside a user token) -- these two URLs are the
// user-token-only variant that page names explicitly.
const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2_user/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.user.access";

// The scopes this project actually needs -- read every conversation type
// the agent might be asked about (public/private channels, group DMs, 1:1
// DMs) AND discover/list them by name (the *:read scopes -- distinct from
// *:history below, which only covers reading messages inside a
// conversation the agent already knows about; found live 2026-09-21
// asking "what Slack channels can you see?", which needs *:read, not
// *:history), search across them (Slack's search API has long required a
// user token, which is part of why the MCP server is user-token-only in
// the first place), post a message (the one write action, mirroring
// GitHub's write tools), and resolve user ids to display names.
// Deliberately not the full scope list Slack's MCP server supports
// (files, canvases, lists, reactions, channel creation are real
// capabilities of the server, just not ones this product uses today) --
// fewer requested scopes means a shorter, more legible consent screen and
// less standing access than the app needs.
const SLACK_USER_SCOPES = [
  "search:read.public",
  "search:read.private",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "chat:write",
  "users:read",
].join(",");

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  // Full URL to this server's own /auth/slack/callback route -- must
  // match a "Redirect URL" registered on the Slack App exactly, or Slack
  // rejects the exchange.
  redirectUri: string;
  // Where to send the browser back to once the flow finishes (success or
  // error) -- the Next.js app's own origin, e.g. http://localhost:3000.
  webAppUrl: string;
}

export interface SlackOAuthDeps {
  // Injectable so tests exercise the real route logic (state handling,
  // storing the token, error redirects) without hitting slack.com -- same
  // "mock only the external network call" line as every other package in
  // this repo (see github-oauth.ts's identical SlackOAuthDeps sibling).
  exchangeCodeForToken: (
    code: string,
    config: SlackOAuthConfig,
  ) => Promise<{ accessToken: string; teamName?: string } | { error: string }>;
}

async function defaultExchangeCodeForToken(
  code: string,
  config: SlackOAuthConfig,
): Promise<{ accessToken: string; teamName?: string } | { error: string }> {
  try {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    });
    const res = await fetch(SLACK_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    // Slack's Web API convention (every api.slack.com/methods/* endpoint,
    // oauth.v2.access included) is to always return HTTP 200 with an `ok`
    // boolean, errors included -- checking `res.ok` alone would miss a real
    // failure, so `ok`/`error` from the parsed body are checked instead,
    // the same convention @slack/web-api itself relies on internally.
    //
    // NOT YET LIVE-VERIFIED: oauth.v2.user.access is a newer endpoint
    // (alongside Slack's MCP server, launched 2026-02-17) and its exact
    // response shape wasn't in any documentation page this session could
    // fetch -- the field names below (`access_token` at the top level,
    // `team.name`) follow Slack's long-established oauth.v2.access
    // convention for a user-token grant, but this is inferred, not
    // confirmed against a real response. If this breaks, the raw response
    // logged below is the first thing to check -- likely just a field
    // rename (e.g. an `authed_user.access_token` nesting instead of a
    // top-level one) to fix here, not a sign the whole approach is wrong.
    const raw = await res.text();
    let parsed: {
      ok?: boolean;
      access_token?: string;
      authed_user?: { access_token?: string };
      team?: { name?: string };
      error?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        error: `Slack's token endpoint returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 300)}`,
      };
    }
    if (!parsed.ok) {
      return { error: parsed.error ?? `Slack rejected the code exchange (HTTP ${res.status}): ${raw.slice(0, 300)}` };
    }
    const accessToken = parsed.access_token ?? parsed.authed_user?.access_token;
    if (!accessToken) {
      console.error(
        "[slack-oauth] Slack's token response had no access_token in either shape this code checks -- raw response:",
        raw,
      );
      return {
        error:
          "Slack accepted the login but this server couldn't find an access token in its response -- see the chat-server's own " +
          "terminal for the raw response that was logged.",
      };
    }
    return { accessToken, teamName: parsed.team?.name };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "Slack took too long to respond. Please try again."
          : "Slack could not be reached. Please try again.",
    };
  }
}

export const defaultSlackOAuthDeps: SlackOAuthDeps = {
  exchangeCodeForToken: defaultExchangeCodeForToken,
};

const STATE_TTL_MS = 10 * 60 * 1000;

function redirectTarget(
  config: SlackOAuthConfig,
  workspaceId: string | undefined,
  status: "connected" | "error",
  message?: string,
): string {
  const url = new URL(workspaceId ? `/w/${workspaceId}` : "/", config.webAppUrl);
  url.searchParams.set("slack", status);
  if (message) url.searchParams.set("slackMessage", message);
  return url.toString();
}

export function registerSlackOAuthRoutes(
  app: Express,
  config: SlackOAuthConfig,
  deps: SlackOAuthDeps = defaultSlackOAuthDeps,
): void {
  app.get("/workspaces/:id/integrations/slack/oauth/start", async (req: Request, res: Response) => {
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
            "Slack login isn't configured on this server (SLACK_OAUTH_CLIENT_ID/SLACK_OAUTH_CLIENT_SECRET are not set).",
        });
    }

    const state = randomUUID();
    await db.saveOAuthPendingState(
      state,
      "slack-integration",
      { workspaceId, userId: req.user!.id },
      new Date(Date.now() + STATE_TTL_MS),
    );

    const authorizeUrl = new URL(SLACK_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
    // NOTE: the dedicated /oauth/v2_user/authorize endpoint (user-token-only,
    // required for Slack's MCP server) takes its scopes under the plain
    // "scope" param -- NOT "user_scope", which is only for the older
    // combined /oauth/v2/authorize endpoint that issues a bot token
    // alongside an optional user token. Confirmed 2026-09-21 against
    // docs.slack.dev/authentication/installing-with-oauth after a real
    // login attempt failed with Slack's "Invalid permissions requested /
    // No scopes requested" error caused by using "user_scope" here.
    authorizeUrl.searchParams.set("scope", SLACK_USER_SCOPES);
    authorizeUrl.searchParams.set("state", state);
    res.redirect(authorizeUrl.toString());
  });

  app.get("/auth/slack/callback", async (req: Request, res: Response) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";

    const pending = await db.consumeOAuthPendingState<{ workspaceId: string; userId: string }>(
      state,
      "slack-integration",
    );

    if (oauthError) {
      return res.redirect(redirectTarget(config, pending?.workspaceId, "error", `Slack said: ${oauthError}`));
    }
    if (!pending) {
      return res.redirect(
        redirectTarget(
          config,
          undefined,
          "error",
          "That Slack login link expired or was already used -- click Log in with Slack again.",
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
        redirectTarget(config, pending.workspaceId, "error", "Slack didn't send back an authorization code."),
      );
    }

    const result = await deps.exchangeCodeForToken(code, config);
    if ("error" in result) {
      return res.redirect(redirectTarget(config, pending.workspaceId, "error", result.error));
    }

    await db.upsertSlackIntegration({
      workspaceId: pending.workspaceId,
      teamName: result.teamName ?? "Slack",
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
        summary: `${req.user.displayName} connected Slack (${result.teamName ?? "Slack"})`,
        metadata: { integration: "slack", teamName: result.teamName ?? "Slack" },
      });
    }
    res.redirect(redirectTarget(config, pending.workspaceId, "connected"));
  });
}
