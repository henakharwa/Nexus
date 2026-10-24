// Approval rules: every member can see them; only Admins change them.
// The rules themselves are evaluated in ../approval-rules.ts.
import * as db from "@mai-chat/db";
import type { Request, Response } from "express";
import type { ApprovalRule } from "@mai-chat/shared-types";
import { UUID_RE, paramString } from "../http-utils.js";
import { MAX_RULES_PER_WORKSPACE, parseApprovalRuleInput, starterRules } from "../approval-rules.js";
import type { RouteContext } from "./context.js";

/** A short description of what a rule does, for the activity log. */
function describeRule(rule: ApprovalRule): string {
  if (rule.effect === "block") return "blocks matching actions";
  if (rule.effect === "auto_approve") return "auto-approves matching actions";
  return `requires ${rule.requiredApprovals} approval${rule.requiredApprovals === 1 ? "" : "s"} from people other than the requester`;
}

export function registerApprovalRulesRoutes({ app, requireRole }: RouteContext): void {
  app.get("/workspaces/:id/approval-rules", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listApprovalRules(paramString(req.params.id)));
  });

  // How many members can approve actions, so the page can warn about rules
  // that ask for more approvers than the workspace has.
  app.get("/workspaces/:id/approval-rules/capacity", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json({ approvers: await db.countWorkspaceApprovers(paramString(req.params.id)) });
  });

  // The recommended starting policy (approval-rules.ts's starterRules).
  // Rules whose name already exists are skipped, so a second click adds nothing.
  app.post("/workspaces/:id/approval-rules/starter", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const existing = await db.listApprovalRules(workspaceId);
    const names = new Set(existing.map((rule) => rule.name.toLowerCase()));
    const toCreate = starterRules(await db.countWorkspaceApprovers(workspaceId)).filter((rule) => !names.has(rule.name.toLowerCase()));
    if (existing.length + toCreate.length > MAX_RULES_PER_WORKSPACE) return res.status(409).json({ error: `A workspace can have up to ${MAX_RULES_PER_WORKSPACE} approval rules.` });
    const created: ApprovalRule[] = [];
    for (const input of toCreate) {
      const rule = await db.createApprovalRule(workspaceId, input, { userId: req.user!.id, name: req.user!.displayName });
      created.push(rule);
      await db.recordAuditEvent({
        workspaceId,
        eventType: "approval_rule.created",
        actorType: "user",
        actorUserId: req.user!.id,
        actorName: req.user!.displayName,
        summary: `${req.user!.displayName} created approval rule “${rule.name}” from the starter policy, which ${describeRule(rule)}`,
        metadata: { ruleId: rule.id, rule: input, starter: true },
      });
    }
    res.status(201).json(created);
  });

  // Standing approvals ("approve similar actions for 7 days" from a card).
  app.get("/workspaces/:id/standing-approvals", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listStandingApprovals(paramString(req.params.id)));
  });

  // Any Admin, or the person who gave it, can revoke a standing approval.
  app.delete("/workspaces/:id/standing-approvals/:approvalId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const approvalId = paramString(req.params.approvalId);
    if (!UUID_RE.test(approvalId)) return res.status(400).json({ error: "invalid id" });
    const approval = await db.getStandingApproval(workspaceId, approvalId);
    if (!approval) return res.status(404).json({ error: "Standing approval not found." });
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (role !== "admin" && approval.createdByUserId !== req.user!.id) return res.status(403).json({ error: "Only an Admin or the person who gave it can revoke a standing approval." });
    await db.revokeStandingApproval(workspaceId, approvalId, req.user!.displayName);
    await db.recordAuditEvent({
      workspaceId,
      eventType: "standing_approval.revoked",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} revoked ${approval.createdByName}'s standing approval (${approval.description})`,
      metadata: { standingApprovalId: approval.id },
    });
    res.status(204).end();
  });

  app.post("/workspaces/:id/approval-rules", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const parsed = parseApprovalRuleInput(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    if ((await db.countApprovalRules(workspaceId)) >= MAX_RULES_PER_WORKSPACE) {
      return res.status(409).json({ error: `A workspace can have up to ${MAX_RULES_PER_WORKSPACE} approval rules. Delete one first.` });
    }
    const rule = await db.createApprovalRule(workspaceId, parsed.input, { userId: req.user!.id, name: req.user!.displayName });
    await db.recordAuditEvent({
      workspaceId,
      eventType: "approval_rule.created",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} created approval rule “${rule.name}”, which ${describeRule(rule)}`,
      metadata: { ruleId: rule.id, rule: parsed.input },
    });
    res.status(201).json(rule);
  });

  app.put("/workspaces/:id/approval-rules/:ruleId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const ruleId = paramString(req.params.ruleId);
    if (!UUID_RE.test(ruleId)) return res.status(400).json({ error: "invalid rule id" });
    const parsed = parseApprovalRuleInput(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const before = await db.getApprovalRule(workspaceId, ruleId);
    const rule = before ? await db.updateApprovalRule(workspaceId, ruleId, parsed.input) : null;
    if (!before || !rule) return res.status(404).json({ error: "Approval rule not found." });
    const change = before.enabled !== rule.enabled ? (rule.enabled ? "turned on" : "turned off") : "updated";
    await db.recordAuditEvent({
      workspaceId,
      eventType: "approval_rule.updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} ${change} approval rule “${rule.name}”, which ${describeRule(rule)}`,
      metadata: { ruleId: rule.id, rule: parsed.input },
    });
    res.json(rule);
  });

  app.delete("/workspaces/:id/approval-rules/:ruleId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const ruleId = paramString(req.params.ruleId);
    if (!UUID_RE.test(ruleId)) return res.status(400).json({ error: "invalid rule id" });
    const rule = await db.getApprovalRule(workspaceId, ruleId);
    if (!rule || !(await db.deleteApprovalRule(workspaceId, ruleId))) return res.status(404).json({ error: "Approval rule not found." });
    await db.recordAuditEvent({
      workspaceId,
      eventType: "approval_rule.deleted",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} deleted approval rule “${rule.name}”`,
      metadata: { ruleId: rule.id },
    });
    res.status(204).end();
  });
}
