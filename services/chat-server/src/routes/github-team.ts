// Team GitHub: GitHub event (webhook) setup and receiver, recent team
// activity, and taking over a workflow whose owner left. Each member works
// in the one repository they chose for their own GitHub connection.
import express, { type Request, type Response } from "express";
import * as db from "@mai-chat/db";
import type { WorkspaceGithubSetup } from "@mai-chat/shared-types";
import { UUID_RE, paramString, errMessage } from "../http-utils.js";
import type { RouteContext } from "./context.js";
import { teamApiFor } from "../actions.js";
import { GITHUB_WEBHOOK_EVENTS, listTeamActivity, verifyGithubSignature } from "../github-team.js";

/** The repositories members of a workspace currently work in ("owner/repo"), one per member at most. */
async function memberRepositories(workspaceId: string): Promise<string[]> {
  const names = (await db.listIntegrations(workspaceId)).flatMap((integration) =>
    integration.type === "github" && integration.owner && integration.repo ? [`${integration.owner}/${integration.repo}`] : []
  );
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()].sort((a, b) => a.localeCompare(b));
}

function publicApiUrl(): string {
  return (process.env.CHAT_SERVER_PUBLIC_URL ?? `http://localhost:${process.env.CHAT_SERVER_PORT ?? 4000}`).replace(/\/+$/, "");
}

export function workspaceWebhookUrl(workspaceId: string): string {
  return `${publicApiUrl()}/webhooks/github/workspaces/${workspaceId}`;
}

/** Handles a verified GitHub event for one workspace (set by createChatServer). */
export type GithubEventHandler = (workspaceId: string, event: string, payload: Record<string, unknown>, deliveryId: string) => Promise<void>;

/**
 * Receivers are registered before the JSON body parser: the signature is
 * computed over the exact bytes GitHub sent.
 */
export function registerGithubWebhookRoutes({ app, deps }: Pick<RouteContext, "app" | "deps">): void {
  const raw = express.raw({ type: "*/*", limit: "10mb" });
  const handlerFor = () => app.locals.handleGithubEvent as GithubEventHandler | undefined;

  async function deliver(req: Request, res: Response, workspaceId: string, event: string, payload: Record<string, unknown>) {
    const deliveryId = req.header("x-github-delivery") ?? `${event}:${Date.now()}`;
    const handler = handlerFor();
    // GitHub retries deliveries; each one is handled once.
    if (!(await db.recordWebhookDelivery(workspaceId, deliveryId, event))) return res.status(202).json({ ok: true, processed: 0 });
    if (handler) await handler(workspaceId, event, payload, deliveryId).catch((error) => console.error("[github-webhook] handling failed", errMessage(error)));
    res.status(202).json({ ok: true, processed: 1 });
  }

  function parse(req: Request, res: Response): { event: string; payload: Record<string, unknown>; body: Buffer } | null {
    const event = req.header("x-github-event");
    if (!event || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Not a GitHub webhook delivery." });
      return null;
    }
    try {
      return { event, payload: JSON.parse(req.body.toString("utf8")) as Record<string, unknown>, body: req.body };
    } catch {
      res.status(400).json({ error: "The delivery body must be JSON (set the webhook content type to application/json)." });
      return null;
    }
  }

  // A repository webhook added for one workspace, signed with that workspace's secret.
  app.post("/webhooks/github/workspaces/:workspaceId", raw, async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.workspaceId);
    if (!UUID_RE.test(workspaceId)) return res.status(404).json({ error: "not found" });
    const secret = await db.getWorkspaceWebhookSecret(workspaceId);
    if (!secret) return res.status(404).json({ error: "This workspace has no GitHub webhook set up." });
    if (!Buffer.isBuffer(req.body) || !verifyGithubSignature(secret, req.body, req.header("x-hub-signature-256"))) {
      return res.status(401).json({ error: "Invalid signature. Check that the webhook secret matches the one shown in Nexus." });
    }
    const parsed = parse(req, res);
    if (!parsed) return;
    // Only events from a repository someone in this workspace works in.
    const fullName = String((parsed.payload.repository as { full_name?: string } | undefined)?.full_name ?? "");
    if (!(await memberRepositories(workspaceId)).some((name) => name.toLowerCase() === fullName.toLowerCase())) {
      return res.status(202).json({ ok: true, processed: 0, note: "No one in this workspace works in this repository." });
    }
    await deliver(req, res, workspaceId, parsed.event, parsed.payload);
  });
}

export function registerGithubTeamRoutes({ app, deps, requireRole, requirePermission }: RouteContext): void {
  const api = () => teamApiFor(deps);

  // The member's own GitHub connection: its token and the repository they chose.
  async function ownGithub(workspaceId: string, userId: string): Promise<{ token: string; owner: string | null; repo: string | null } | null> {
    const integration = (await db.listIntegrations(workspaceId)).find((candidate) => candidate.type === "github" && candidate.ownerUserId === userId);
    const credential = integration ? await db.getIntegrationCredential(workspaceId, "github", integration.id) : null;
    return credential?.token ? { token: credential.token, owner: credential.owner ?? null, repo: credential.repo ?? null } : null;
  }

  app.get("/workspaces/:id/github/setup", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const isAdmin = (await db.getWorkspaceRole(workspaceId, req.user!.id)) === "admin";
    const status = await db.getWorkspaceWebhookStatus(workspaceId);
    const mine = await ownGithub(workspaceId, req.user!.id);
    const setup: WorkspaceGithubSetup = {
      webhookUrl: workspaceWebhookUrl(workspaceId),
      ...(isAdmin ? { webhookSecret: await db.getOrCreateWorkspaceWebhookSecret(workspaceId) } : {}),
      events: GITHUB_WEBHOOK_EVENTS,
      lastDeliveryAt: status.lastDeliveryAt,
      lastEvent: status.lastEvent,
      myRepository: mine?.owner && mine.repo ? `${mine.owner}/${mine.repo}` : null,
      repositories: await memberRepositories(workspaceId),
    };
    res.json(setup);
  });

  app.post("/workspaces/:id/github/webhook-secret/rotate", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const secret = await db.rotateWorkspaceWebhookSecret(workspaceId);
    await db.recordAuditEvent({ workspaceId, eventType: "repository.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} replaced the GitHub webhook secret` });
    res.json({ webhookSecret: secret });
  });

  // Adds the GitHub webhook to the Admin's own repository with their own
  // GitHub account (they need admin rights on that repository).
  app.post("/workspaces/:id/github/webhook", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const mine = await ownGithub(workspaceId, req.user!.id);
    if (!mine) return res.status(400).json({ error: "Connect your GitHub account first." });
    if (!mine.owner || !mine.repo) return res.status(400).json({ error: "Choose your repository under GitHub first." });
    const fullName = `${mine.owner}/${mine.repo}`;
    try {
      const secret = await db.getOrCreateWorkspaceWebhookSecret(workspaceId);
      const hook = await api().createRepoWebhook(mine.token, mine.owner, mine.repo, { url: workspaceWebhookUrl(workspaceId), secret, events: GITHUB_WEBHOOK_EVENTS });
      await db.recordAuditEvent({ workspaceId, eventType: "repository.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} connected GitHub events for ${fullName}`, metadata: { repo: fullName } });
      res.json({ repository: fullName, webhookId: hook.id });
    } catch (error) {
      res.status(400).json({ error: errMessage(error) });
    }
  });

  app.get("/workspaces/:id/team-activity", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await listTeamActivity(paramString(req.params.id), { hours: 24, limit: 20 }));
  });

  // Only an Admin may take over a workflow, for example when its owner left.
  app.post("/workspaces/:id/workflows/:workflowId/take-over", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const workflow = await db.setWorkflowOwner(workspaceId, paramString(req.params.workflowId), req.user!.id);
    if (!workflow) return res.status(404).json({ error: "Workflow not found." });
    await db.recordAuditEvent({ workspaceId, eventType: "workflow.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} took over workflow ${workflow.name}`, metadata: { workflowId: workflow.id } });
    res.json(workflow);
  });
}
