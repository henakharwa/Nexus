// Workspace agents: builder, versions and publishing.
import * as db from "@mai-chat/db";
import { paramString } from "../http-utils.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";
import { ABUSE_LIMITS, enforceAbuseLimit } from "../abuse-limits.js";

const AGENT_NAME_MAX = 80;

export function registerAgentsRoutes({ app, requireRole, requirePermission }: RouteContext): void {
  async function requireAgentOwnerOrAdmin(
    req: Request,
    res: Response,
    agent: NonNullable<Awaited<ReturnType<typeof db.getWorkspaceAgent>>>,
  ): Promise<boolean> {
    const role = await db.getWorkspaceRole(agent.workspaceId, req.user!.id);
    if (role === "admin" || agent.ownerUserId === req.user!.id) return true;
    res.status(403).json({ error: "Only this agent's owner or a workspace Admin can change it." });
    return false;
  }
  app.get("/workspaces/:id/agents", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceAgents(paramString(req.params.id)));
  });
  app.get("/workspaces/:id/agent-models", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const configured = (process.env.AGENT_LLM_ALLOWED_MODELS ?? "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    res.json(["workspace-default", ...configured]);
  });
  app.post("/workspaces/:id/agents", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const body = req.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || !["project", "github", "slack", "linear", "notion", "figma"].includes(body.baseAgent))
      return res.status(400).json({ error: "A name and base agent are required." });
    if (name.length > AGENT_NAME_MAX)
      return res.status(400).json({ error: `Agent names can be up to ${AGENT_NAME_MAX} characters.` });
    if (!(await enforceAbuseLimit(res, ABUSE_LIMITS.agentCreate, req.user!.id))) return;
    const agent = await db.createWorkspaceAgent({
      workspaceId: paramString(req.params.id),
      name,
      baseAgent: body.baseAgent,
      instructions: typeof body.instructions === "string" ? body.instructions : "",
      knowledge: typeof body.knowledge === "string" ? body.knowledge : "",
      approvedProviders: Array.isArray(body.approvedProviders)
        ? body.approvedProviders.filter((item: unknown) =>
            ["github", "slack", "linear", "notion", "figma"].includes(item as string),
          )
        : [],
      model: typeof body.model === "string" ? body.model : "workspace-default",
      ownerUserId: req.user!.id,
    });
    await db.recordAuditEvent({
      workspaceId: agent.workspaceId,
      eventType: "agent.created",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} created agent draft ${agent.name}`,
    });
    res.status(201).json(agent);
  });
  app.patch("/workspaces/:id/agents/:agentId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const existing = await db.getWorkspaceAgent(paramString(req.params.id), paramString(req.params.agentId));
    if (!existing) return res.status(404).json({ error: "Agent not found." });
    if (!(await requireAgentOwnerOrAdmin(req, res, existing))) return;
    const body = req.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    if (name !== undefined && !name) return res.status(400).json({ error: "An agent name is required." });
    if (name !== undefined && name.length > AGENT_NAME_MAX)
      return res.status(400).json({ error: `Agent names can be up to ${AGENT_NAME_MAX} characters.` });
    const agent = await db.updateWorkspaceAgent(paramString(req.params.id), paramString(req.params.agentId), {
      name,
      baseAgent: ["project", "github", "slack", "linear", "notion", "figma"].includes(body.baseAgent)
        ? body.baseAgent
        : undefined,
      instructions: typeof body.instructions === "string" ? body.instructions : undefined,
      knowledge: typeof body.knowledge === "string" ? body.knowledge : undefined,
      approvedProviders: Array.isArray(body.approvedProviders)
        ? body.approvedProviders.filter((item: unknown) =>
            ["github", "slack", "linear", "notion", "figma"].includes(item as string),
          )
        : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
    });
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    await db.recordAuditEvent({
      workspaceId: agent.workspaceId,
      eventType: "agent.updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} updated agent ${agent.name}`,
    });
    res.json(agent);
  });
  app.post("/workspaces/:id/agents/:agentId/publish", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "publishAgents"))) return;
    const draft = await db.getWorkspaceAgent(paramString(req.params.id), paramString(req.params.agentId));
    if (!draft) return res.status(404).json({ error: "Agent not found." });
    if (!(await requireAgentOwnerOrAdmin(req, res, draft))) return;
    if (!draft.instructions.trim())
      return res.status(400).json({ error: "Instructions are required before publishing an agent." });
    const agent = await db.publishWorkspaceAgent(
      paramString(req.params.id),
      paramString(req.params.agentId),
      req.user!.id,
    );
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    await db.recordAuditEvent({
      workspaceId: agent.workspaceId,
      eventType: "agent.published",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} published ${agent.name} version ${agent.publishedVersion}`,
    });
    res.json(agent);
  });
  app.delete("/workspaces/:id/agents/:agentId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const existing = await db.getWorkspaceAgent(paramString(req.params.id), paramString(req.params.agentId));
    if (!existing) return res.status(404).json({ error: "Agent not found." });
    if (!(await requireAgentOwnerOrAdmin(req, res, existing))) return;
    const agent = await db.deleteWorkspaceAgent(paramString(req.params.id), paramString(req.params.agentId));
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    await db.recordAuditEvent({
      workspaceId: agent.workspaceId,
      eventType: "agent.deleted",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} deleted agent ${agent.name}`,
    });
    res.status(204).end();
  });
  app.get("/workspaces/:id/agents/:agentId/versions", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceAgentVersions(paramString(req.params.id), paramString(req.params.agentId)));
  });
}
