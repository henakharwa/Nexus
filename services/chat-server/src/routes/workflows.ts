// Workflows, manual runs and observability settings.
import * as db from "@mai-chat/db";
import { UUID_RE, paramString } from "../http-utils.js";
import { resolveLlmConfig } from "../llm-client.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerWorkflowsRoutes({ app, requireRole, requirePermission }: RouteContext): void {
  const workflowTriggers = ["manual", "schedule", "github_issue", "github_status", "slack_mention"] as const;
  const workflowAgents = ["project", "github", "slack", "linear", "notion", "figma"] as const;
  function workflowInput(body: Record<string, unknown>) {
    const trigger = workflowTriggers.includes(body.trigger as (typeof workflowTriggers)[number])
      ? (body.trigger as (typeof workflowTriggers)[number])
      : "manual";
    const agentKind = workflowAgents.includes(body.agentKind as (typeof workflowAgents)[number])
      ? (body.agentKind as (typeof workflowAgents)[number])
      : "project";
    const scheduleMinutes = Number(body.scheduleMinutes);
    return {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : "",
      instructions: typeof body.instructions === "string" ? body.instructions : "",
      agentKind,
      workspaceAgentId:
        typeof body.workspaceAgentId === "string" && UUID_RE.test(body.workspaceAgentId) ? body.workspaceAgentId : null,
      conversationId:
        typeof body.conversationId === "string" && UUID_RE.test(body.conversationId) ? body.conversationId : null,
      trigger,
      scheduleMinutes:
        trigger === "schedule" && Number.isInteger(scheduleMinutes) && scheduleMinutes >= 5 && scheduleMinutes <= 10080
          ? scheduleMinutes
          : null,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
      // Omitted on update means "keep the saved setting".
      ...(typeof body.requiresApproval === "boolean" ? { requiresApproval: body.requiresApproval } : {}),
    };
  }

  async function requireWorkflowOwnerOrAdmin(
    req: Request,
    res: Response,
    workflow: NonNullable<Awaited<ReturnType<typeof db.getWorkspaceWorkflow>>>,
  ): Promise<boolean> {
    const role = await db.getWorkspaceRole(workflow.workspaceId, req.user!.id);
    if (role === "admin" || workflow.ownerUserId === req.user!.id) return true;
    res.status(403).json({ error: "Only this workflow's owner or a workspace Admin can change it." });
    return false;
  }

  app.get("/workspaces/:id/workflows", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceWorkflows(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/workflows", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "manageWorkflows"))) return;
    const input = workflowInput(req.body ?? {});
    if (!input.name.trim() || !input.instructions.trim())
      return res.status(400).json({ error: "A workflow name and instructions are required." });
    if (input.name.trim().length > 120)
      return res.status(400).json({ error: "Workflow names can be up to 120 characters." });
    if (input.trigger === "schedule" && !input.scheduleMinutes)
      return res.status(400).json({ error: "Choose an interval between 5 minutes and 7 days." });
    if (
      input.workspaceAgentId &&
      !(await db.getPublishedWorkspaceAgent(paramString(req.params.id), input.workspaceAgentId))
    )
      return res.status(400).json({ error: "Choose a published workspace agent." });
    if (input.conversationId && !(await db.getConversation(paramString(req.params.id), input.conversationId)))
      return res.status(400).json({ error: "Choose a conversation in this workspace." });
    const workflow = await db.createWorkspaceWorkflow(paramString(req.params.id), req.user!.id, input);
    await db.recordAuditEvent({
      workspaceId: workflow.workspaceId,
      eventType: "workflow.created",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} created workflow ${workflow.name}`,
    });
    res.status(201).json(workflow);
  });
  app.patch("/workspaces/:id/workflows/:workflowId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "manageWorkflows"))) return;
    const existing = await db.getWorkspaceWorkflow(paramString(req.params.id), paramString(req.params.workflowId));
    if (!existing) return res.status(404).json({ error: "Workflow not found." });
    if (!(await requireWorkflowOwnerOrAdmin(req, res, existing))) return;
    const input = workflowInput(req.body ?? {});
    if (!input.name.trim() || !input.instructions.trim())
      return res.status(400).json({ error: "A workflow name and instructions are required." });
    if (input.name.trim().length > 120)
      return res.status(400).json({ error: "Workflow names can be up to 120 characters." });
    if (input.trigger === "schedule" && !input.scheduleMinutes)
      return res.status(400).json({ error: "Choose an interval between 5 minutes and 7 days." });
    if (
      input.workspaceAgentId &&
      !(await db.getPublishedWorkspaceAgent(paramString(req.params.id), input.workspaceAgentId))
    )
      return res.status(400).json({ error: "Choose a published workspace agent." });
    if (input.conversationId && !(await db.getConversation(paramString(req.params.id), input.conversationId)))
      return res.status(400).json({ error: "Choose a conversation in this workspace." });
    const workflow = await db.updateWorkspaceWorkflow(
      paramString(req.params.id),
      paramString(req.params.workflowId),
      input,
    );
    if (!workflow) return res.status(404).json({ error: "Workflow not found." });
    await db.recordAuditEvent({
      workspaceId: workflow.workspaceId,
      eventType: "workflow.updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} updated workflow ${workflow.name}`,
    });
    res.json(workflow);
  });
  app.delete("/workspaces/:id/workflows/:workflowId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "manageWorkflows"))) return;
    const existing = await db.getWorkspaceWorkflow(paramString(req.params.id), paramString(req.params.workflowId));
    if (!existing) return res.status(404).json({ error: "Workflow not found." });
    if (!(await requireWorkflowOwnerOrAdmin(req, res, existing))) return;
    const workflow = await db.deleteWorkspaceWorkflow(paramString(req.params.id), paramString(req.params.workflowId));
    if (!workflow) return res.status(404).json({ error: "Workflow not found." });
    await db.recordAuditEvent({
      workspaceId: workflow.workspaceId,
      eventType: "workflow.deleted",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} deleted workflow ${workflow.name}`,
    });
    res.status(204).end();
  });
  app.get("/workspaces/:id/workflows/:workflowId/runs", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const parsedLimit = Number(req.query.limit);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    const before =
      typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before))
        ? req.query.before
        : undefined;
    res.json(
      await db.listWorkflowRuns(paramString(req.params.id), paramString(req.params.workflowId), { limit, before }),
    );
  });
  // All recent runs in the workspace in one request (Observability).
  app.get("/workspaces/:id/workflow-runs", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const parsedLimit = Number(req.query.limit);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 200;
    const before =
      typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before))
        ? req.query.before
        : undefined;
    res.json(await db.listWorkspaceWorkflowRuns(paramString(req.params.id), { limit, before }));
  });
  app.get("/workspaces/:id/observability/retention", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json({
      ...(await db.getObservabilityRetentionPolicy(paramString(req.params.id))),
      perTurnTokenLimit: resolveLlmConfig().tpmLimit,
    });
  });
  app.put("/workspaces/:id/observability/retention", async (req: Request, res: Response) => {
    // Observability controls are Admin only; Editors can view retention status.
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    // Failure-alert threshold (Admin observability control) may be saved on its own.
    if (req.body?.failureAlertThreshold !== undefined) {
      const threshold = Number(req.body.failureAlertThreshold);
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 20)
        return res.status(400).json({ error: "failureAlertThreshold must be a whole number from 1 to 20" });
      const saved = await db.updateFailureAlertThreshold(workspaceId, threshold);
      if (req.body?.retentionDays === undefined) return res.json({ ...saved, removed: 0 });
    }
    const retentionDays = Number(req.body?.retentionDays);
    if (![7, 30, 90, 365].includes(retentionDays))
      return res.status(400).json({ error: "retentionDays must be 7, 30, 90, or 365" });
    const policy = await db.updateObservabilityRetentionPolicy(workspaceId, retentionDays as 7 | 30 | 90 | 365);
    const removed = await db.enforceWorkflowRunRetention(workspaceId);
    res.json({ ...policy, removed });
  });
  app.post("/workspaces/:id/workflows/:workflowId/run", async (req: Request, res: Response) => {
    // Running a workflow is a workflow change: Admins by default, Editors
    // only with the manageWorkflows permission.
    if (!(await requirePermission(req, res, "manageWorkflows"))) return;
    const workflow = await db.getWorkspaceWorkflow(paramString(req.params.id), paramString(req.params.workflowId));
    if (!workflow) return res.status(404).json({ error: "Workflow not found." });
    const requestedTrigger = req.body?.trigger;
    const trigger =
      workflowTriggers.includes(requestedTrigger) && requestedTrigger !== "schedule" ? requestedTrigger : "manual";
    if (trigger !== "manual" && trigger !== workflow.trigger)
      return res.status(400).json({ error: "This event does not match the workflow trigger." });
    const eventText = typeof req.body?.eventText === "string" ? req.body.eventText.trim().slice(0, 4_000) : "";
    const runner = app.locals.runWorkflow as
      | undefined
      | ((
          workflow: Awaited<ReturnType<typeof db.getWorkspaceWorkflow>>,
          trigger: (typeof workflowTriggers)[number],
          user: { id: string; displayName: string },
          eventText?: string,
        ) => Promise<void>);
    if (!runner) return res.status(503).json({ error: "Workflow runner is starting. Try again in a moment." });
    void runner(workflow, trigger, { id: req.user!.id, displayName: req.user!.displayName }, eventText || undefined);
    res.status(202).json({ accepted: true });
  });
}
