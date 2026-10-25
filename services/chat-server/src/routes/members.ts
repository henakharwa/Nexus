// Membership: change role, remove member, leave workspace.
import * as db from "@mai-chat/db";
import { UUID_RE, paramString } from "../http-utils.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerMembersRoutes({ app, requireRole }: RouteContext): void {
  app.patch("/workspaces/:id/members/:userId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const role = req.body?.role;
    if (role !== "admin" && role !== "editor") return res.status(400).json({ error: "valid role is required" });
    const members = await db.listWorkspaceMembersWithRoles(paramString(req.params.id));
    const target = members.find((member) => member.id === paramString(req.params.userId));
    if (!target) return res.status(404).json({ error: "member not found" });
    if (
      target.role === "admin" &&
      role !== "admin" &&
      members.filter((member) => member.role === "admin").length === 1
    ) {
      return res.status(409).json({ error: "A workspace must keep at least one admin." });
    }
    await db.setWorkspaceMemberRole(paramString(req.params.id), target.id, role);
    await db.recordAuditEvent({
      workspaceId: paramString(req.params.id),
      eventType: "member.role_changed",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} changed ${target.displayName}'s role to ${role}`,
    });
    res.status(204).end();
  });

  app.delete("/workspaces/:id/members/:userId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const userId = paramString(req.params.userId);
    const members = await db.listWorkspaceMembersWithRoles(workspaceId);
    const target = members.find((member) => member.id === userId);
    if (!target) return res.status(404).json({ error: "member not found" });
    if (target.role === "admin" && members.filter((member) => member.role === "admin").length === 1)
      return res.status(409).json({ error: "A workspace must keep at least one admin." });
    if (!(await db.removeWorkspaceMemberAndPersonalIntegrations(workspaceId, userId)))
      return res.status(404).json({ error: "member not found" });
    await db.recordAuditEvent({
      workspaceId,
      eventType: "member.removed",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} removed ${target.displayName}; the join code was rotated`,
    });
    res.status(204).end();
  });

  // Members may leave a workspace themselves. Personal integrations are
  // removed with their membership so an explicit future rejoin begins with
  // no retained provider credentials.
  app.delete("/workspaces/:id/membership", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role) return res.status(404).json({ error: "member not found" });
    if (role !== "admin")
      return res.status(403).json({ error: "Editors cannot leave a workspace. Ask an Admin to remove you instead." });
    const members = await db.listWorkspaceMembersWithRoles(workspaceId);
    if (members.length > 1 && members.filter((member) => member.role === "admin").length === 1) {
      return res
        .status(409)
        .json({ error: "Make another member an Admin before leaving. A workspace must keep at least one admin." });
    }
    if (!(await db.removeWorkspaceMemberAndPersonalIntegrations(workspaceId, req.user!.id))) {
      return res.status(404).json({ error: "member not found" });
    }
    await db.recordAuditEvent({
      workspaceId,
      eventType: "member.left",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} left the workspace, removed their personal tool connections, and rotated the join code`,
    });
    res.status(204).end();
  });
}
