// Workspaces: create, invite, join, list, permissions and permission requests.
import * as db from "@mai-chat/db";
import { UUID_RE, errMessage, paramString } from "../http-utils.js";
import { requireAuth } from "../auth.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerWorkspacesRoutes({ app, deps, webAppUrl, requireRole }: RouteContext): void {
  app.post("/workspaces", async (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? db.normalizeWorkspaceName(req.body.name) : "";
    if (!name) return res.status(400).json({ error: "name is required" });
    let workspace;
    try {
      workspace = await db.createWorkspace(name, req.user!.id);
    } catch (error) {
      if (error instanceof db.WorkspaceNameTakenError)
        return res.status(409).json({ error: error.message, workspace: error.workspace });
      throw error;
    }
    await db.addWorkspaceMember(workspace.id, req.user!.id, "admin");
    await db.createConversation({ workspaceId: workspace.id, createdByUserId: req.user!.id });
    await db.recordAuditEvent({
      workspaceId: workspace.id,
      eventType: "workspace.created",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} created the workspace "${workspace.name}"`,
    });
    res.status(201).json(workspace);
  });

  app.post("/workspaces/:id/invitations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      return res.status(400).json({ error: "A valid email address is required." });
    const role = req.body?.role;
    if (role !== "admin" && role !== "editor") return res.status(400).json({ error: "Choose Admin or Editor access." });
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    if (await db.isWorkspaceMemberEmail(workspaceId, email))
      return res.status(409).json({ error: "This user is already in the workspace." });
    const invite = await db.createWorkspaceInvitation({ workspaceId, email, invitedByUserId: req.user!.id, role });
    const inviteUrl = new URL("/", webAppUrl);
    inviteUrl.searchParams.set("invite", invite.token);
    try {
      await deps.mailer.send({
        to: invite.email,
        subject: `You're invited to ${workspace.name} on Nexus`,
        text: `${req.user!.displayName} invited you to join the ${workspace.name} workspace as an ${invite.role}.\n\nOpen this invitation: ${inviteUrl}\n\nSign in or create an account with ${invite.email}. This invitation expires in 7 days.`,
      });
    } catch (error) {
      await db.deleteWorkspaceInvitation(invite.token);
      const message = errMessage(error);
      console.error(
        JSON.stringify({ level: "error", event: "workspace_invitation_email_failed", workspaceId, error: message }),
      );
      const publicError = /EAUTH|Invalid login|Username and Password not accepted/i.test(message)
        ? "Gmail rejected the sign-in. Check the Gmail address and use a new Google App Password."
        : /Outbound email is not configured/i.test(message)
          ? "Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM_ADDRESS, or the GMAIL_SMTP_* or GMAIL_API_* settings, then redeploy."
          : /invalid_grant|Token has been expired or revoked/i.test(message)
            ? "Gmail API access has expired or been revoked. Generate a new GMAIL_API_REFRESH_TOKEN (publish the Google OAuth app to Production so it stops expiring) and update it in Render."
            : /invalid_client|unauthorized_client/i.test(message)
              ? "Gmail API client credentials were rejected. Check GMAIL_API_CLIENT_ID and GMAIL_API_CLIENT_SECRET in Render."
              : /Gmail API send failed: (401|403)/i.test(message)
                ? "Gmail API refused to send. Make sure the refresh token was created for GMAIL_SMTP_USER with the gmail.send scope and that the Gmail API is enabled."
                : /Gmail API token refresh failed/i.test(message)
                  ? "Could not get a Gmail API access token. Check the GMAIL_API_* settings in Render."
                  : /Resend/i.test(message)
                    ? "Resend rejected the email. Check RESEND_API_KEY and that EMAIL_FROM_ADDRESS uses a verified domain."
                    : /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|timeout|aborted/i.test(message)
                      ? "The server could not connect to the email provider. Render’s free plan blocks Gmail SMTP; use the Gmail API settings instead."
                      : "The invitation email could not be sent. Check the email configuration and the server logs (event workspace_invitation_email_failed).";
      return res.status(502).json({ error: publicError });
    }
    await db.recordAuditEvent({
      workspaceId,
      eventType: "member.invited",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} invited ${invite.email} to join the workspace as ${invite.role}`,
    });
    res.status(201).json({ email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
  });

  app.get("/workspaces/:id/invitations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    res.json(await db.listWorkspaceInvitations(workspaceId));
  });

  app.delete("/workspaces/:id/invitations/:invitationId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!(await db.revokeWorkspaceInvitation(workspaceId, paramString(req.params.invitationId))))
      return res.status(404).json({ error: "invitation not found" });
    res.status(204).end();
  });

  app.get("/workspaces/:id/join-policy", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json({ approvalRequired: await db.getWorkspaceJoinApprovalRequired(paramString(req.params.id)) });
  });

  app.put("/workspaces/:id/join-policy", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    if (typeof req.body?.approvalRequired !== "boolean")
      return res.status(400).json({ error: "approvalRequired must be a boolean" });
    const workspaceId = paramString(req.params.id);
    await db.setWorkspaceJoinApprovalRequired(workspaceId, req.body.approvalRequired);
    await db.recordAuditEvent({
      workspaceId,
      eventType: "workspace.permissions_updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} ${req.body.approvalRequired ? "required" : "allowed"} Admin approval for join-code requests`,
    });
    res.status(204).end();
  });

  app.get("/workspaces/:id/join-requests", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    res.json(await db.listWorkspaceJoinRequests(paramString(req.params.id)));
  });

  app.post("/workspaces/:id/join-requests/:requestId/:decision", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const decision = paramString(req.params.decision);
    if (decision !== "approve" && decision !== "deny") return res.status(404).json({ error: "not found" });
    const workspaceId = paramString(req.params.id);
    const requestId = paramString(req.params.requestId);
    if (!UUID_RE.test(requestId)) return res.status(404).json({ error: "join request not found" });
    const result = await db.resolveWorkspaceJoinRequest(workspaceId, requestId, req.user!.id, decision === "approve");
    if (!result) return res.status(404).json({ error: "join request not found" });
    await db.recordAuditEvent({
      workspaceId,
      eventType: decision === "approve" ? "member.join_approved" : "member.join_denied",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} ${decision === "approve" ? "approved" : "denied"} a join-code request`,
    });
    res.status(204).end();
  });

  app.post("/workspace-invitations/accept", requireAuth, async (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token || token.length > 256) return res.status(400).json({ error: "A valid invitation is required." });
    const result = await db.acceptWorkspaceInvitation(token, req.user!.id);
    if (result.kind === "invalid")
      return res.status(404).json({ error: "This invitation is invalid, expired, or has already been used." });
    if (result.kind === "email_mismatch")
      return res
        .status(403)
        .json({ error: `This invitation was sent to ${result.email}. Sign in with that email address to join.` });
    await db.recordAuditEvent({
      workspaceId: result.workspaceId,
      eventType: "member.joined",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} joined the workspace through an email invitation`,
    });
    res.json({ workspaceId: result.workspaceId });
  });

  // Bound join-code guessing per account and per network address. Only failed
  // lookups count, so people who join many real workspaces are never blocked.
  const JOIN_GUESS_WINDOW_SECONDS = 900;
  const JOIN_GUESS_USER_LIMIT = 20;
  const JOIN_GUESS_IP_LIMIT = 60;
  async function joinGuessingBlocked(req: Request, res: Response): Promise<boolean> {
    const blocked =
      (await db.isRateLimited("workspace-join-user", req.user!.id, JOIN_GUESS_USER_LIMIT)) ||
      (await db.isRateLimited("workspace-join-ip", req.ip ?? "unknown", JOIN_GUESS_IP_LIMIT));
    if (!blocked) return false;
    res.setHeader("Retry-After", String(JOIN_GUESS_WINDOW_SECONDS));
    res.status(429).json({ error: "Too many join attempts. Try again in 15 minutes." });
    return true;
  }
  async function recordFailedJoinGuess(req: Request): Promise<void> {
    await db.consumeRateLimit("workspace-join-user", req.user!.id, JOIN_GUESS_USER_LIMIT, JOIN_GUESS_WINDOW_SECONDS);
    await db.consumeRateLimit("workspace-join-ip", req.ip ?? "unknown", JOIN_GUESS_IP_LIMIT, JOIN_GUESS_WINDOW_SECONDS);
  }

  app.get("/workspaces/by-code/:joinCode", async (req: Request, res: Response) => {
    if (await joinGuessingBlocked(req, res)) return;
    const workspace = await db.getWorkspaceByJoinCode(paramString(req.params.joinCode));
    if (!workspace) {
      await recordFailedJoinGuess(req);
      return res.status(404).json({ error: "not found" });
    }
    res.json(workspace);
  });

  // Join by code (shared capability). New members join as Editors; an
  // existing member keeps their current role.
  app.post("/workspaces/by-code/:joinCode/join", async (req: Request, res: Response) => {
    if (await joinGuessingBlocked(req, res)) return;
    const workspace = await db.getWorkspaceByJoinCode(paramString(req.params.joinCode));
    if (!workspace) {
      await recordFailedJoinGuess(req);
      return res.status(404).json({ error: "No workspace found for that join code." });
    }
    const existingMembers = await db.listWorkspaceMembersWithRoles(workspace.id);
    if (
      !existingMembers.some((member) => member.id === req.user!.id) &&
      (await db.getWorkspaceJoinApprovalRequired(workspace.id))
    ) {
      const requested = await db.createWorkspaceJoinRequest(workspace.id, req.user!.id);
      if (!requested.alreadyPending)
        await db.recordAuditEvent({
          workspaceId: workspace.id,
          eventType: "member.join_requested",
          actorType: "user",
          actorUserId: req.user!.id,
          actorName: req.user!.displayName,
          summary: `${req.user!.displayName} requested to join using the workspace code`,
        });
      return res.status(202).json({ pending: true });
    }
    const joined = await db.addWorkspaceMember(
      workspace.id,
      req.user!.id,
      existingMembers.length === 0 ? "admin" : "editor",
    );
    if (joined) {
      await db.recordAuditEvent({
        workspaceId: workspace.id,
        eventType: "member.joined",
        actorType: "user",
        actorUserId: req.user!.id,
        actorName: req.user!.displayName,
        summary: `${req.user!.displayName} joined the workspace`,
      });
    }
    res.json(workspace);
  });

  app.get("/workspaces", async (req: Request, res: Response) => {
    res.json(await db.listWorkspacesForUser(req.user!.id));
  });

  app.get("/workspaces/:id", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(paramString(req.params.id));
    if (!workspace) return res.status(404).json({ error: "not found" });
    res.json(workspace);
  });

  app.delete("/workspaces/:id", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    if (!(await db.deleteWorkspace(paramString(req.params.id)))) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  app.get("/workspaces/:id/members", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    res.json(await db.listWorkspaceMembersWithRoles(workspaceId));
  });

  app.get("/workspaces/:id/permissions", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.getWorkspacePermissionPolicy(paramString(req.params.id)));
  });

  // The signed-in member's effective access, as described by the Nexus role
  // access matrix: Admins hold every permission; Editors hold the saved
  // Editor policy. The web app uses this to show enabled, disabled, or
  // request-access states without duplicating policy logic.
  app.get("/workspaces/:id/access", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const role = (await db.getWorkspaceRole(workspaceId, req.user!.id))!;
    const policy = await db.getWorkspacePermissionPolicy(workspaceId);
    const permissions =
      role === "admin" ? Object.fromEntries(Object.keys(policy.admin).map((key) => [key, true])) : policy.editor;
    res.json({ role, permissions });
  });

  app.put("/workspaces/:id/permissions", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const policy = req.body;
    if (!policy?.admin || !policy?.editor)
      return res.status(400).json({ error: "Admin and Editor permissions are required." });
    const saved = await db.setWorkspacePermissionPolicy(paramString(req.params.id), policy);
    await db.recordAuditEvent({
      workspaceId: paramString(req.params.id),
      eventType: "workspace.permissions_updated",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} updated workspace permissions`,
    });
    res.json(saved);
  });
  app.get("/workspaces/:id/permission-requests", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    res.json(await db.listPermissionRequests(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/permission-requests", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["editor"]))) return;
    const permission = req.body?.permission;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const policy = await db.getWorkspacePermissionPolicy(paramString(req.params.id));
    if (!Object.keys(policy.editor).includes(permission)) return res.status(400).json({ error: "Invalid permission." });
    if (policy.editor[permission as keyof import("@mai-chat/shared-types").WorkspacePermissions])
      return res.status(409).json({ error: "You already have this permission." });
    if (!reason || reason.length > 1000)
      return res.status(400).json({ error: "Give a reason between 1 and 1,000 characters." });
    const alreadyPending = (await db.listPermissionRequests(paramString(req.params.id))).some(
      (item) => item.user_id === req.user!.id && item.permission === permission,
    );
    if (alreadyPending)
      return res.status(409).json({ error: "You already asked for this permission. An Admin will review it." });
    res
      .status(201)
      .json(await db.createPermissionRequest(paramString(req.params.id), req.user!.id, permission, reason));
  });
  app.post("/workspaces/:id/permission-requests/:requestId/:decision", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const decision = paramString(req.params.decision);
    if (decision !== "approve" && decision !== "reject") return res.status(404).json({ error: "Unknown decision." });
    const workspaceId = paramString(req.params.id);
    const request = await db.resolvePermissionRequest(
      workspaceId,
      paramString(req.params.requestId),
      decision === "approve" ? "approved" : "denied",
    );
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (decision === "approve") {
      const policy = await db.getWorkspacePermissionPolicy(workspaceId);
      policy.editor[request.permission] = true;
      await db.setWorkspacePermissionPolicy(workspaceId, policy);
      await db.notifyWorkspaceUser({
        workspaceId,
        userId: request.user_id,
        kind: "permission_request",
        text: `${req.user!.displayName} approved your request for ${request.permission}. You can use it now.`,
      });
    } else {
      await db.notifyWorkspaceUser({
        workspaceId,
        userId: request.user_id,
        kind: "permission_request",
        text: `${req.user!.displayName} declined your request for ${request.permission}.`,
      });
    }
    res.status(204).end();
  });
}
