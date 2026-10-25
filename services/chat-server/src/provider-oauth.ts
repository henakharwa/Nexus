import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import * as db from "@mai-chat/db";

type Provider = "linear" | "notion" | "figma";
const providerInfo: Record<Provider, { authorize: string; token: string; endpoint: string; scope: string }> = {
  linear: {
    authorize: "https://linear.app/oauth/authorize",
    token: "https://api.linear.app/oauth/token",
    endpoint: "https://mcp.linear.app/mcp",
    scope: "read,write",
  },
  notion: {
    authorize: "https://api.notion.com/v1/oauth/authorize",
    token: "https://api.notion.com/v1/oauth/token",
    endpoint: "notion-rest",
    scope: "",
  },
  // Figma tools call the REST API directly (figma-tools.ts), so no MCP URL is
  // needed. folders:read lets the agent find files by name in a team; every
  // scope requested here must also be enabled in the Figma app's OAuth
  // settings (FIGMA_OAUTH_SCOPES overrides this list).
  figma: {
    authorize: "https://www.figma.com/oauth",
    token: "https://api.figma.com/v1/oauth/token",
    endpoint: "https://api.figma.com/v1",
    scope: "file_content:read,file_comments:read,file_comments:write,current_user:read,folders:read",
  },
};
function infoFor(kind: Provider) {
  const info = providerInfo[kind];
  return kind === "figma" && process.env.FIGMA_OAUTH_SCOPES?.trim()
    ? { ...info, scope: process.env.FIGMA_OAUTH_SCOPES.trim() }
    : info;
}
function provider(value: string): Provider | null {
  return value === "linear" || value === "notion" || value === "figma" ? value : null;
}
function config(kind: Provider) {
  const prefix = kind.toUpperCase();
  const publicUrl = process.env.CHAT_SERVER_PUBLIC_URL ?? `http://localhost:${process.env.CHAT_SERVER_PORT ?? 4000}`;
  return {
    clientId: process.env[`${prefix}_OAUTH_CLIENT_ID`] ?? "",
    clientSecret: process.env[`${prefix}_OAUTH_CLIENT_SECRET`] ?? "",
    redirectUri: `${publicUrl}/auth/mcp/${kind}/callback`,
    webAppUrl: process.env.WEB_APP_URL ?? "http://localhost:3000",
  };
}
function back(kind: Provider, workspaceId: string, status: "connected" | "error", message?: string) {
  const url = new URL(`/w/${workspaceId}`, config(kind).webAppUrl);
  url.searchParams.set(kind, status);
  if (message) url.searchParams.set(`${kind}Message`, message);
  return url.toString();
}
async function connectedAccountName(
  kind: Provider,
  token: string,
  result: { workspace_name?: string },
): Promise<string | undefined> {
  if (kind === "notion") return result.workspace_name;
  try {
    if (kind === "linear") {
      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { name } organization { name } }" }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as {
        data?: { viewer?: { name?: string }; organization?: { name?: string } };
      };
      return body.data?.organization?.name ?? body.data?.viewer?.name;
    }
    if (kind === "figma") {
      const response = await fetch("https://api.figma.com/v1/me", {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as { handle?: string; email?: string };
      return body.handle ?? body.email;
    }
  } catch {
    /* Account labels are optional; they must never block OAuth. */
  }
  return undefined;
}

export function registerProviderOAuthRoutes(app: Express): void {
  app.get("/workspaces/:id/integrations/:provider/oauth/start", async (req: Request, res: Response, next) => {
    const kind = provider(String(req.params.provider));
    const workspaceId = String(req.params.id);
    // GitHub and Slack install their own OAuth start handlers later in the
    // route list. Let them handle those provider names instead of claiming
    // this shared URL pattern and returning a misleading 404.
    if (!kind) return next();
    if (!(await db.getWorkspaceById(workspaceId))) return res.status(404).json({ error: "not found" });
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role || !(await db.hasWorkspacePermissionForUser(workspaceId, role, req.user!.id, "connectTools")))
      return res.status(403).json({ error: "You do not have permission to connect this tool." });
    const oauth = config(kind);
    const info = infoFor(kind);
    if (!oauth.clientId || !oauth.clientSecret || !info.endpoint)
      return res
        .status(503)
        .json({
          error: `${kind} account login needs ${kind.toUpperCase()}_OAUTH_CLIENT_ID and ${kind.toUpperCase()}_OAUTH_CLIENT_SECRET configured on the server.`,
        });
    const state = randomUUID();
    await db.saveOAuthPendingState(
      state,
      "provider",
      { workspaceId, provider: kind, userId: req.user!.id },
      new Date(Date.now() + 600_000),
    );
    const url = new URL(info.authorize);
    url.searchParams.set("client_id", oauth.clientId);
    url.searchParams.set("redirect_uri", oauth.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    if (kind === "notion") url.searchParams.set("owner", "user");
    if (info.scope) url.searchParams.set("scope", info.scope);
    res.redirect(url.toString());
  });
  app.get("/auth/mcp/:provider/callback", async (req: Request, res: Response) => {
    const kind = provider(String(req.params.provider));
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const pending = await db.consumeOAuthPendingState<{ workspaceId: string; provider: Provider; userId: string }>(
      state,
      "provider",
    );
    if (!kind || !pending || pending.provider !== kind || !code)
      return res.status(400).send("This connection link expired. Please return to the workspace and try again.");
    // The token is saved for whoever started this flow, so only that same
    // signed-in session may finish it. Otherwise someone could start a
    // connection and send the provider's link to another person, whose
    // account would then be stored as theirs.
    if (req.user?.id !== pending.userId)
      return res.redirect(
        back(
          kind,
          pending.workspaceId,
          "error",
          "Please finish connecting in the same browser and account you started from.",
        ),
      );
    const oauth = config(kind);
    const info = infoFor(kind);
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: oauth.redirectUri });
    if (kind === "linear") {
      body.set("client_id", oauth.clientId);
      body.set("client_secret", oauth.clientSecret);
    }
    const headers: Record<string, string> = {
      "content-type": kind === "notion" ? "application/json" : "application/x-www-form-urlencoded",
    };
    if (kind === "notion" || kind === "figma")
      headers.authorization = `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64")}`;
    const requestBody = kind === "notion" ? JSON.stringify(Object.fromEntries(body)) : body.toString();
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(info.token, {
        method: "POST",
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === "TimeoutError"
          ? "The provider took too long to respond. Please try again."
          : "The provider could not be reached. Please try again.";
      return res.redirect(back(kind, pending.workspaceId, "error", message));
    }
    const result = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error_description?: string;
      error?: string;
      workspace_name?: string;
    };
    if (!response.ok || !result.access_token)
      return res.redirect(
        back(kind, pending.workspaceId, "error", result.error_description ?? result.error ?? "Account login failed."),
      );
    const accountName = await connectedAccountName(kind, result.access_token, result);
    await db.upsertRemoteMcpIntegration({
      workspaceId: pending.workspaceId,
      type: kind,
      endpoint: info.endpoint,
      token: result.access_token,
      ownerUserId: pending.userId,
      accountName,
    });
    const user = await db.getUserById(pending.userId);
    const label = kind[0].toUpperCase() + kind.slice(1);
    await db.recordAuditEvent({
      workspaceId: pending.workspaceId,
      eventType: "integration.connected",
      actorType: "user",
      actorUserId: pending.userId,
      actorName: user?.displayName ?? "A workspace member",
      summary: `${user?.displayName ?? "A workspace member"} connected ${label}${accountName ? ` (${accountName})` : ""}`,
      metadata: { integration: kind },
    });
    res.redirect(back(kind, pending.workspaceId, "connected"));
  });
}
