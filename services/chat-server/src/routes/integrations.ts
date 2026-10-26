// Integrations: connect, test, list and disconnect provider connections.
import * as db from "@mai-chat/db";
import { UUID_RE, errMessage, paramString } from "../http-utils.js";
import { testIntegrationConnection } from "../integration-health.js";
import { listFigmaTeamProjects, parseFigmaTeamId } from "../figma-tools.js";
import { registerGithubOAuthRoutes } from "../github-oauth.js";
import { registerSlackOAuthRoutes } from "../slack-oauth.js";
import type { Request, Response } from "express";
import type { AuditEventType } from "@mai-chat/shared-types";
import type { RouteContext } from "./context.js";

export function registerIntegrationsRoutes({ app, deps, requireRole, requirePermission }: RouteContext): void {
  // Real connection check for one connection (Integrations → Test connection).
  app.post("/workspaces/:id/integrations/:integrationKey/test", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const key = paramString(req.params.integrationKey);
    const integration = (await db.listIntegrations(workspaceId)).find((item) => item.id === key || (!item.id && item.type === key));
    if (!integration) return res.status(404).json({ error: "Connection not found." });
    res.json(await testIntegrationConnection(workspaceId, integration));
  });

  app.get("/workspaces/:id/integrations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(paramString(req.params.id));
    if (!workspace) return res.status(404).json({ error: "not found" });
    res.json(await db.listIntegrations(paramString(req.params.id)));
  });

  app.get("/workspaces/:id/capabilities/connect-tools", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "connectTools"))) return;
    res.status(204).end();
  });

  app.delete("/workspaces/:id/integrations/:provider", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "connectTools"))) return;
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const provider = paramString(req.params.provider);
    const integrationId = typeof req.query.integrationId === "string" ? req.query.integrationId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!["github", "slack", "linear", "notion", "figma"].includes(provider)) return res.status(404).json({ error: "unknown integration" });
    if (!UUID_RE.test(integrationId)) return res.status(400).json({ error: "valid integrationId is required" });
    const providerName = provider as "github" | "slack" | "linear" | "notion" | "figma";
    const credential = await db.getIntegrationCredentialForOwner(workspaceId, providerName, integrationId, req.user!.id);
    if (!credential) return res.status(404).json({ error: "integration not found or is not owned by you" });
    await deps.revokeProviderToken?.(providerName, credential.token, providerName === "github" ? { clientId: deps.githubOAuthConfig.clientId, clientSecret: deps.githubOAuthConfig.clientSecret } : undefined);
    const removed = await db.deleteIntegrationForOwner(workspaceId, providerName, integrationId, req.user!.id);
    if (!removed) return res.status(404).json({ error: "integration not found or is not owned by you" });
    await db.recordAuditEvent({ workspaceId, eventType: "integration.disconnected" as AuditEventType, actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} disconnected ${provider}`, metadata: { integration: provider } });
    res.status(204).end();
  });

  // Every provider connects only through its own login (OAuth): GitHub and
  // Slack below, Linear/Notion/Figma in provider-oauth.ts. There is no
  // pasted-token route, so a member never handles a raw provider token here.

  // Figma's API cannot list a member's teams, so the member who connected
  // Figma names one team whose projects and files the agent may browse.
  // The team is checked with that member's own token before it is saved.
  app.post("/workspaces/:id/integrations/figma/team", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "connectTools"))) return;
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    let teamId: string;
    try {
      teamId = parseFigmaTeamId(req.body?.team);
    } catch (error) {
      return res.status(400).json({ error: errMessage(error) });
    }
    const own = (await db.listIntegrations(workspaceId)).find((integration) => integration.type === "figma" && integration.ownerUserId === req.user!.id);
    const credential = own?.id ? await db.getIntegrationCredential(workspaceId, "figma", own.id) : null;
    if (!own || !credential?.token) return res.status(409).json({ error: "Connect your Figma account first." });
    let teamName: string | undefined;
    try {
      teamName = (await (deps.figmaTeamLoader ?? listFigmaTeamProjects)(credential.token, teamId)).teamName;
    } catch (error) {
      return res.status(400).json({ error: `Figma could not list that team's folders with your connection (${errMessage(error)}). Check the team link, make sure the Figma app's OAuth settings include the "folders:read" scope, then reconnect Figma and set the team again.` });
    }
    await db.setFigmaTeam({ workspaceId, ownerUserId: req.user!.id, teamId, teamName: teamName?.replace(/:/g, " ") });
    res.json({ teamId, teamName });
  });

  registerGithubOAuthRoutes(app, deps.githubOAuthConfig, deps.githubOAuthDeps);
  registerSlackOAuthRoutes(app, deps.slackOAuthConfig, deps.slackOAuthDeps);

  app.post("/workspaces/:id/integrations/github/repo", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "connectTools"))) return;
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspaceId = paramString(req.params.id);
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    const { owner, repo } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof owner !== "string" || typeof repo !== "string" || !owner || !repo) {
      return res.status(400).json({ error: "owner and repo are both required" });
    }
    const integration = (await db.listIntegrations(workspaceId)).find(
      (candidate) => candidate.type === "github" && candidate.ownerUserId === req.user!.id
    );
    const credential = integration ? await db.getIntegrationCredential(workspaceId, "github", integration.id) : null;
    if (!credential) return res.status(404).json({ error: "GitHub isn't connected for this workspace yet." });
    try {
      // Same "verify against the live API before saving" policy as the
      // pasted-token route above -- a repo picked from the list should
      // always work, but the token's access could have changed between
      // listing and picking (e.g. an org revoked it).
      await deps.githubClientFactory({ token: credential.token, owner, repo }).listIssues("open", 1);
    } catch (err) {
      return res.status(400).json({ error: `could not verify access to ${owner}/${repo}: ${errMessage(err)}` });
    }
    const config = await db.setGithubRepo({ workspaceId, owner, repo, ownerUserId: req.user!.id });
    if (!config) return res.status(404).json({ error: "GitHub isn't connected for this workspace yet." });
    // Each member works in one repository at a time; choosing another
    // replaces it. Recorded so teammates can see who works where.
    await db.recordAuditEvent({ workspaceId, eventType: "repository.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} is now working in ${owner}/${repo}`, metadata: { repo: `${owner}/${repo}` } });
    res.json(config);
  });

  // No pasted-bot-token Slack route anymore -- Slack connects ONLY via
  // OAuth now (registerSlackOAuthRoutes above), since Slack's official
  // MCP server requires a real user access token from that exact flow; a
  // hand-pasted token could never authenticate to it. See slack-oauth.ts.
}
