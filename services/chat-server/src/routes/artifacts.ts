// Artifacts: CRUD, versions, generation, comments, presence and sharing.
import * as db from "@mai-chat/db";
import { errMessage, paramString } from "../http-utils.js";
import { parseWorkspaceArtifactInput } from "../input-parsers.js";
import {
  aiArtifactDraft,
  workspaceDashboardSnapshot,
  workspaceReleaseNotesDraft,
  workspaceReportDraft,
} from "../artifact-drafts.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerArtifactsRoutes({ app, deps, requireRole, requirePermission }: RouteContext): void {
  // Reading, presence, and comments remain shared review capabilities.
  // Every other state-changing artifact action is governed by the policy.
  app.use("/workspaces/:id/artifacts", async (req: Request, res: Response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || /\/(comments|presence)$/.test(req.path)) return next();
    if (await requirePermission(req, res, "manageArtifacts")) next();
  });
  async function canManageArtifact(req: Request, artifactId: string) {
    const workspaceId = paramString(req.params.id);
    const artifact = await db.getWorkspaceArtifact(workspaceId, artifactId);
    if (!artifact) return { artifact: null, allowed: false };
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    return { artifact, allowed: role === "admin" || artifact.createdByUserId === req.user!.id };
  }
  app.get("/workspaces/:id/artifacts", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceArtifacts(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/artifacts", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const input = parseWorkspaceArtifactInput(req.body ?? {});
    if (!input.title || !input.content)
      return res.status(400).json({ error: "An artifact title and content are required." });
    if (input.title.length > 200)
      return res.status(400).json({ error: "Artifact titles can be up to 200 characters." });
    if (input.ownerUserId && !(await db.getWorkspaceRole(paramString(req.params.id), input.ownerUserId)))
      return res.status(400).json({ error: "Artifact owner must be a workspace member." });
    const artifact = await db.createWorkspaceArtifact(paramString(req.params.id), req.user!.id, input);
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.created",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} created ${artifact.type.replace("_", " ")} ${artifact.title}`,
    });
    res.status(201).json(artifact);
  });
  app.patch("/workspaces/:id/artifacts/:artifactId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can edit it." });
    const input = parseWorkspaceArtifactInput(req.body ?? {});
    if (!input.title || !input.content)
      return res.status(400).json({ error: "An artifact title and content are required." });
    if (input.title.length > 200)
      return res.status(400).json({ error: "Artifact titles can be up to 200 characters." });
    if (input.ownerUserId && !(await db.getWorkspaceRole(paramString(req.params.id), input.ownerUserId)))
      return res.status(400).json({ error: "Artifact owner must be a workspace member." });
    const artifact = await db.updateWorkspaceArtifact(
      paramString(req.params.id),
      paramString(req.params.artifactId),
      input,
      req.user!.id,
    );
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} updated artifact ${artifact.title}`,
    });
    res.json(artifact);
  });
  app.delete("/workspaces/:id/artifacts/:artifactId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can delete it." });
    const artifact = await db.deleteWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId));
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.deleted",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} deleted artifact ${artifact.title}`,
    });
    res.status(204).end();
  });
  app.get("/workspaces/:id/artifacts/:artifactId/versions", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!(await db.getWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId))))
      return res.status(404).json({ error: "Artifact not found." });
    res.json(await db.listWorkspaceArtifactVersions(paramString(req.params.id), paramString(req.params.artifactId)));
  });
  app.post("/workspaces/:id/artifacts/:artifactId/versions/:versionId/restore", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed)
      return res.status(403).json({ error: "Only the artifact author or an Admin can restore a version." });
    const artifact = await db.restoreWorkspaceArtifactVersion(
      paramString(req.params.id),
      paramString(req.params.artifactId),
      paramString(req.params.versionId),
      req.user!.id,
    );
    if (!artifact) return res.status(404).json({ error: "Artifact version not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} restored version of artifact ${artifact.title}`,
    });
    res.json(artifact);
  });
  app.post("/workspaces/:id/artifacts/:artifactId/refresh-dashboard", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can refresh it." });
    if (access.artifact.type !== "dashboard")
      return res.status(400).json({ error: "Only Dashboard artifacts can be refreshed." });
    const dashboardData = await workspaceDashboardSnapshot(access.artifact.workspaceId, deps, req.user!.id);
    const artifact = await db.updateWorkspaceArtifact(
      access.artifact.workspaceId,
      access.artifact.id,
      {
        type: access.artifact.type,
        status: access.artifact.status,
        title: access.artifact.title,
        summary: access.artifact.summary,
        content: access.artifact.content,
        dashboardData,
        ownerUserId: access.artifact.ownerUserId,
        releaseVersion: access.artifact.releaseVersion,
      },
      req.user!.id,
    );
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "system",
      actorName: "Dashboard refresh",
      summary: `${req.user!.displayName} refreshed live workspace data for ${artifact.title}`,
    });
    res.json(artifact);
  });

  app.post("/workspaces/:id/artifacts/:artifactId/generate-assisted-draft", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed)
      return res.status(403).json({ error: "Only the artifact author or an Admin can generate it." });
    if (access.artifact.type === "dashboard")
      return res.status(400).json({ error: "Dashboards use Refresh live data instead." });
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    let content: string;
    try {
      content = await aiArtifactDraft(access.artifact.workspaceId, access.artifact, prompt, deps);
    } catch (error) {
      return res.status(503).json({ error: `AI draft unavailable: ${errMessage(error)}` });
    }
    const artifact = await db.updateWorkspaceArtifact(
      access.artifact.workspaceId,
      access.artifact.id,
      {
        type: access.artifact.type,
        status: access.artifact.status,
        title: access.artifact.title,
        summary: access.artifact.summary,
        content,
        dashboardData: null,
        ownerUserId: access.artifact.ownerUserId,
        releaseVersion: access.artifact.releaseVersion,
      },
      req.user!.id,
    );
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "system",
      actorName: "Artifact assistant",
      summary: `${req.user!.displayName} generated a workspace-assisted draft for ${artifact.title}`,
    });
    res.json(artifact);
  });
  app.post("/workspaces/:id/artifacts/:artifactId/generate-release-notes", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed)
      return res.status(403).json({ error: "Only the artifact author or an Admin can generate it." });
    if (access.artifact.type !== "release_notes")
      return res.status(400).json({ error: "Only Release notes artifacts can be generated." });
    const content = await workspaceReleaseNotesDraft(
      access.artifact.workspaceId,
      access.artifact.id,
      deps,
      req.user!.id,
    );
    const artifact = await db.updateWorkspaceArtifact(
      access.artifact.workspaceId,
      access.artifact.id,
      {
        type: access.artifact.type,
        status: access.artifact.status,
        title: access.artifact.title,
        summary: access.artifact.summary,
        content,
        dashboardData: null,
        ownerUserId: access.artifact.ownerUserId,
        releaseVersion: access.artifact.releaseVersion,
      },
      req.user!.id,
    );
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "system",
      actorName: "Release notes generator",
      summary: `${req.user!.displayName} generated release notes for ${artifact.title} from GitHub activity`,
    });
    res.json(artifact);
  });

  app.post("/workspaces/:id/artifacts/:artifactId/generate-report", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed)
      return res.status(403).json({ error: "Only the artifact author or an Admin can generate it." });
    if (access.artifact.type !== "report")
      return res.status(400).json({ error: "Only Report artifacts can be generated." });
    const content = await workspaceReportDraft(access.artifact.workspaceId, access.artifact.id);
    const artifact = await db.updateWorkspaceArtifact(
      access.artifact.workspaceId,
      access.artifact.id,
      {
        type: access.artifact.type,
        status: access.artifact.status,
        title: access.artifact.title,
        summary: access.artifact.summary,
        content,
        dashboardData: null,
        ownerUserId: access.artifact.ownerUserId,
        releaseVersion: access.artifact.releaseVersion,
      },
      req.user!.id,
    );
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "system",
      actorName: "Report generator",
      summary: `${req.user!.displayName} generated a status report for ${artifact.title} from workspace activity`,
    });
    res.json(artifact);
  });

  app.post("/workspaces/:id/artifacts/:artifactId/share-to-slack", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can share it." });
    const channel = typeof req.body?.channel === "string" ? req.body.channel.trim() : "";
    if (!channel) return res.status(400).json({ error: "A Slack channel is required." });
    // Never borrow a teammate's Slack identity for a direct share.
    const slackIntegration = (await db.listIntegrations(access.artifact.workspaceId)).find(
      (integration) => integration.type === "slack" && integration.ownerUserId === req.user!.id,
    );
    if (!slackIntegration?.id) return res.status(400).json({ error: "Slack isn't connected for this workspace yet." });
    const credential = await db.getIntegrationCredential(access.artifact.workspaceId, "slack", slackIntegration.id);
    if (!credential) return res.status(400).json({ error: "Slack isn't connected for this workspace yet." });
    const text = `*${access.artifact.title}*${access.artifact.releaseVersion ? ` (${access.artifact.releaseVersion})` : ""}\n${access.artifact.content.slice(0, 2800)}`;
    try {
      await deps.slackClientFactory({ token: credential.token }).postMessage(channel, text);
    } catch (err) {
      return res.status(400).json({ error: `Could not post to Slack: ${errMessage(err)}` });
    }
    await db.recordAuditEvent({
      workspaceId: access.artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} shared ${access.artifact.type.replace("_", " ")} "${access.artifact.title}" to Slack (#${channel})`,
    });
    res.status(204).end();
  });
  app.get("/workspaces/:id/artifacts/:artifactId/comments", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!(await db.getWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId))))
      return res.status(404).json({ error: "Artifact not found." });
    res.json(await db.listWorkspaceArtifactComments(paramString(req.params.id), paramString(req.params.artifactId)));
  });
  app.post("/workspaces/:id/artifacts/:artifactId/comments", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) return res.status(400).json({ error: "A comment is required." });
    const artifact = await db.getWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId));
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    const comment = await db.createWorkspaceArtifactComment(
      artifact.workspaceId,
      artifact.id,
      req.user!.id,
      content.slice(0, 8_000),
    );
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.commented",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} commented on artifact ${artifact.title}`,
    });
    res.status(201).json(comment);
  });

  // A database-backed heartbeat lets all server instances report the same
  // active dashboard viewers. Entries naturally expire after 20 seconds.
  app.post("/workspaces/:id/artifacts/:artifactId/presence", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const artifactId = paramString(req.params.artifactId);
    if (!(await db.getWorkspaceArtifact(workspaceId, artifactId)))
      return res.status(404).json({ error: "Artifact not found." });
    res.json({ viewers: await db.heartbeatArtifactPresence(workspaceId, artifactId, req.user!.id) });
  });

  // Generates (or, with DELETE, revokes) a public, unauthenticated
  // read-only link for a dashboard -- see GET /public/dashboards/:token
  // above. Anyone who can already manage the artifact can toggle this;
  // there's nothing workspace-private in what the link exposes (see
  // PublicDashboardView).
  app.post("/workspaces/:id/artifacts/:artifactId/share", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can share it." });
    const expiresInHours = req.body?.expiresInHours;
    const allowedExpiryHours = [24, 24 * 7, 24 * 30] as const;
    if (
      expiresInHours !== undefined &&
      expiresInHours !== null &&
      (!Number.isInteger(expiresInHours) || !allowedExpiryHours.includes(expiresInHours))
    ) {
      return res.status(400).json({ error: "Public links may expire in 1 day, 7 days, 30 days, or never." });
    }
    const expiresAt = typeof expiresInHours === "number" ? new Date(Date.now() + expiresInHours * 3_600_000) : null;
    const artifact = await db.setArtifactShareToken(access.artifact.workspaceId, access.artifact.id, false, expiresAt);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} created a public share link for ${artifact.title}`,
      metadata: { expiresAt: artifact.shareExpiresAt },
    });
    res.json(artifact);
  });
  app.delete("/workspaces/:id/artifacts/:artifactId/share", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed)
      return res.status(403).json({ error: "Only the artifact author or an Admin can revoke sharing." });
    const artifact = await db.setArtifactShareToken(access.artifact.workspaceId, access.artifact.id, true);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({
      workspaceId: artifact.workspaceId,
      eventType: "artifact.updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} revoked the public share link for ${artifact.title}`,
    });
    res.json(artifact);
  });
}
