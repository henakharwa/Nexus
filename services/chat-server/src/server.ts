import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import * as db from "@mai-chat/db";
import type { Participant } from "@mai-chat/shared-types";
import { RoomRegistry } from "./rooms.js";
import { createPostgresRoomBus, realtimeBusEnabled } from "./realtime-bus.js";
import { toLlmHistory } from "./history.js";
import { replyForResolvedActions, stripConfirmationBoilerplate, type AgentKind } from "./agent.js";
import { resolveLlmConfig } from "./llm-client.js";
import { buildToolsForWorkspace, wrapForProposal, registerActionRoutes, expireStaleActions } from "./actions.js";
import { registerGithubTeamRoutes, registerGithubWebhookRoutes, type GithubEventHandler } from "./routes/github-team.js";
import { formatTeamActivity, listTeamActivity, summarizeGithubEvent } from "./github-team.js";
import type { MessageProvenance, TeamActivity } from "@mai-chat/shared-types";
import { parseMentions } from "./mentions.js";
import { UUID_RE, paramString, errMessage } from "./http-utils.js";
import { attachUser, requireAuth, parseSessionToken, registerUserAuthRoutes, type UserAuthConfig } from "./auth.js";
import { registerEmailVerificationRoutes } from "./email-verification.js";
import { registerPasswordResetRoutes } from "./password-reset.js";
import { registerProviderOAuthRoutes } from "./provider-oauth.js";
import { defaultDeps, type CreateServerDeps } from "./server-deps.js";
import { captureError } from "./error-tracking.js";
import type { RouteContext } from "./routes/context.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerNotificationsRoutes } from "./routes/notifications.js";
import { registerWorkspacesRoutes } from "./routes/workspaces.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerWorkflowsRoutes } from "./routes/workflows.js";
import { registerTasksRoutes } from "./routes/tasks.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerArtifactsRoutes } from "./routes/artifacts.js";
import { registerMembersRoutes } from "./routes/members.js";
import { registerConversationsRoutes } from "./routes/conversations.js";
import { registerPreferencesRoutes } from "./routes/preferences.js";
import { registerIntegrationsRoutes } from "./routes/integrations.js";
import { registerApprovalRulesRoutes } from "./routes/approval-rules.js";
import { workflowRequestsExternalChange, preferWorkspaceMemoryForRepositoryUnavailableWorkflow } from "./input-parsers.js";

// Re-exported so existing imports (tests, actions.ts, index.ts) keep working.
export * from "./server-deps.js";
export { workflowRequestsExternalChange, parseWorkspaceMemoryInput, preferWorkspaceMemoryForRepositoryUnavailableWorkflow, parseWorkspaceArtifactInput } from "./input-parsers.js";


// Workspace HTTP routes and WebSocket connections require a valid session.
// The landing page stays public. OAuth login reuses the integration callback,
// with a login-prefixed state distinguishing authentication from repo access.

export function createApp(deps: CreateServerDeps = defaultDeps) {
  const app = express();
  // Browser Origin never includes a trailing slash. Normalizing the
  // configured URL avoids rejecting legitimate deployed requests when a
  // host dashboard stores the URL as `https://example.com/`.
  const webAppUrl = (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const chatServerPublicUrl = (process.env.CHAT_SERVER_PUBLIC_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  const publicApiPath = new URL(chatServerPublicUrl).pathname.replace(/\/+$/, "");
  // Behind the bundled Caddy proxy every request would otherwise appear to
  // come from 127.0.0.1, so per-IP sign-in and reset limits would be shared
  // by all users. Trust exactly the proxy hops in front of this process
  // (TRUST_PROXY_HOPS=1 for the Oracle deployment: Caddy only).
  const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (Number.isInteger(trustedProxyHops) && trustedProxyHops > 0) app.set("trust proxy", trustedProxyHops);
  app.use(cors({ origin: webAppUrl, credentials: true }));
  // GitHub webhook receivers verify a signature over the raw request body,
  // so they are registered before the JSON parser.
  registerGithubWebhookRoutes({ app, deps });
  app.use(express.json());
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      // Keep normal successful traffic quiet. These JSON lines never include
      // request bodies or secrets. A 4xx is the client's outcome (not signed
      // in, no permission, a conflict) and is logged as a warning; only a
      // 5xx is the server's own failure and logged as an error.
      if (res.statusCode >= 500) console.error(JSON.stringify({ level: "error", event: "http_request", requestId, method: req.method, path: req.path, status: res.statusCode }));
      else if (res.statusCode >= 400) console.warn(JSON.stringify({ level: "warn", event: "http_request", requestId, method: req.method, path: req.path, status: res.statusCode }));
    });
    next();
  });
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin && req.headers.origin !== webAppUrl) {
      res.status(403).json({ error: "Untrusted request origin" });
      return;
    }
    next();
  });
  app.use(attachUser());
  const userAuthConfig: UserAuthConfig = {
    ...deps.githubOAuthConfig,
    google: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirectUri: `${chatServerPublicUrl}/auth/login/google/callback`,
    },
    redirectUri: deps.githubOAuthConfig.redirectUri,
    webAppUrl,
    secureCookie: new URL(webAppUrl).protocol === "https:",
    authCookiePath: `${publicApiPath}/auth` || "/auth",
    emailVerificationEnabled: process.env.EMAIL_VERIFICATION_ENABLED === "true",
  };
  registerUserAuthRoutes(app, userAuthConfig, deps.userAuthDeps, deps.mailer);
  registerEmailVerificationRoutes(app, userAuthConfig, deps.mailer);
  registerPasswordResetRoutes(app, userAuthConfig, deps.mailer);
  app.use("/workspaces", requireAuth);
  // A malformed entity id can never match a row, so answer 404 up front
  // instead of letting Postgres reject the value as a 500.
  for (const name of ["taskId", "agentId", "memoryId", "artifactId", "workflowId", "conversationId", "requestId", "userId", "versionId", "invitationId", "repositoryId"]) {
    app.param(name, (req: Request, res: Response, next: NextFunction, value: string) => {
      if (UUID_RE.test(value)) return next();
      res.status(404).json({ error: "not found" });
    });
  }
  registerProviderOAuthRoutes(app);

  // Shared guard for workspace routes: a malformed id is a 400 (never a
  // database error), an unknown workspace is a 404, and an existing
  // workspace the caller can't use is a 403.
  async function checkWorkspaceId(req: Request, res: Response): Promise<string | null> {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) {
      res.status(400).json({ error: "invalid workspace id" });
      return null;
    }
    return workspaceId;
  }
  async function missingWorkspace(res: Response, workspaceId: string): Promise<boolean> {
    if (await db.getWorkspaceById(workspaceId)) return false;
    res.status(404).json({ error: "not found" });
    return true;
  }

  async function requireRole(req: Request, res: Response, allowed: Array<"admin" | "editor">): Promise<boolean> {
    const workspaceId = await checkWorkspaceId(req, res);
    if (!workspaceId) return false;
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role && (await missingWorkspace(res, workspaceId))) return false;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "You do not have permission to perform this action." });
      return false;
    }
    return true;
  }

  async function requirePermission(req: Request, res: Response, permission: keyof import("@mai-chat/shared-types").WorkspacePermissions): Promise<boolean> {
    const workspaceId = await checkWorkspaceId(req, res);
    if (!workspaceId) return false;
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role && (await missingWorkspace(res, workspaceId))) return false;
    if (!role || !(await db.hasWorkspacePermission(workspaceId, role, permission))) {
      res.status(403).json({ error: "Your workspace role does not have permission for this action." });
      return false;
    }
    return true;
  }

  // Routes live in ./routes/*, grouped by feature area. Order matches the
  // original single-file registration order.
  const routeContext: RouteContext = { app, deps, webAppUrl, requireRole, requirePermission };
  registerPublicRoutes(routeContext);
  registerNotificationsRoutes(routeContext);
  registerWorkspacesRoutes(routeContext);
  registerAgentsRoutes(routeContext);
  registerWorkflowsRoutes(routeContext);
  registerTasksRoutes(routeContext);
  registerMemoryRoutes(routeContext);
  registerArtifactsRoutes(routeContext);
  registerMembersRoutes(routeContext);
  registerConversationsRoutes(routeContext);
  registerPreferencesRoutes(routeContext);
  registerIntegrationsRoutes(routeContext);
  registerGithubTeamRoutes(routeContext);
  registerApprovalRulesRoutes(routeContext);

  return app;
}

// A dashboard's health flipping is the one dashboard event worth pushing
// live rather than leaving someone to notice next time they open the
// Activity page -- the frontend calls this right after a refresh whose
// result's health differs from what it had before. Needs `rooms`, which
// only exists once createChatServer has stood up the WebSocket layer, so
// (like registerActionRoutes) this is added to the app separately from
// createApp's own routes rather than living inside it.
export function registerDashboardBroadcastRoutes(app: Express, rooms: RoomRegistry): void {
  app.post("/workspaces/:id/artifacts/:artifactId/notify-health-change", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    const artifactId = paramString(req.params.artifactId);
    const artifact = await db.getWorkspaceArtifact(workspaceId, artifactId);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role) return res.status(403).json({ error: "Not a member of this workspace." });
    const fromHealth = typeof req.body?.fromHealth === "string" ? req.body.fromHealth : "unknown";
    const toHealth = typeof req.body?.toHealth === "string" ? req.body.toHealth : artifact.dashboardData?.health ?? "unknown";
    const summary = `${artifact.title} health changed: ${fromHealth.replace("_", " ")} → ${toHealth.replace("_", " ")}`;
    await db.recordAuditEvent({ workspaceId, eventType: "artifact.updated", actorType: "system", actorName: "Dashboard health", summary });
    rooms.broadcast(workspaceId, { type: "dashboard_health_changed", artifactId, artifactTitle: artifact.title, fromHealth, toHealth });
    res.status(204).end();
  });
}

// Longest chat message accepted (the web composer enforces the same limit,
// apps/web/lib/config.ts). Every message is stored, broadcast to the whole
// room and sent to the LLM, so an unbounded one is a cheap way to fill the
// database and run up model costs.
export const MAX_CHAT_MESSAGE_CHARS = 20_000;
// Largest raw WebSocket frame. Generous for a 20,000-character message in
// JSON (multi-byte characters included), far below ws's 100 MiB default.
const MAX_WS_PAYLOAD_BYTES = 256 * 1024;
// Agent turns each person may start per hour across all workspaces; each
// turn is a paid LLM call. Override with AGENT_TURNS_PER_USER_PER_HOUR.
function agentTurnsPerUserPerHour(): number {
  const configured = Number(process.env.AGENT_TURNS_PER_USER_PER_HOUR);
  return Number.isInteger(configured) && configured > 0 ? configured : 60;
}

function sendSafely(ws: WebSocket, payload: unknown): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error("websocket send failed", error);
  }
}

export function createChatServer(deps: CreateServerDeps = defaultDeps) {
  const app = createApp(deps);
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_WS_PAYLOAD_BYTES });
  // In production, live events and the agent-turn lock are shared through
  // Postgres so the service can run as more than one process.
  const roomBus = realtimeBusEnabled() ? createPostgresRoomBus() : undefined;
  const rooms = new RoomRegistry(roomBus);
  registerActionRoutes(app, deps, rooms);
  registerDashboardBroadcastRoutes(app, rooms);

  // A WebSocket can go dark without ever firing a "close" event -- a
  // laptop sleeping, wifi dropping, a dev-server hot reload orphaning the
  // old connection object -- which otherwise leaves a stale entry sitting
  // in RoomRegistry forever (and shows up as a "ghost" duplicate in the
  // presence list, e.g. the same person listed twice after reconnecting,
  // since the old dead connection never got cleaned up). Standard `ws`
  // library pattern: ping every open connection on an interval, and
  // terminate any socket that didn't answer the PREVIOUS ping with a
  // pong. terminate() synchronously emits "close", which runs the normal
  // rooms.leave()/presence-rebroadcast handling below, same as any other
  // disconnect.
  type HeartbeatSocket = WebSocket & { isAlive?: boolean };
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as HeartbeatSocket;
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
    rooms.refreshPresence();
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  async function runAgentReply(
    workspaceId: string,
    conversationId: string,
    // userId is null only when no member can be attributed.
    requestedBy: { userId: string | null; name: string },
    agentKind: AgentKind,
    configuredAgentId?: string,
    workflowInstructions?: string,
    workflowReadOnly = false,
    // False for workflow runs marked "Requires approval": approval rules
    // can't auto-approve their writes (block and require-approvals rules
    // still apply).
    allowAutoApprove = true
  ): Promise<{ toolCalls: number; estimatedTokens: number; estimatedCostUsd: number; providerPromptTokens: number | null; providerCompletionTokens: number | null; providerCostUsd: number | null; outputExcerpt: string; inputExcerpt: string | null; toolTrace: Array<{ name: string; durationMs: number; status: "succeeded" | "failed" }> }> {
    const configuredAgent = configuredAgentId ? await db.getPublishedWorkspaceAgent(workspaceId, configuredAgentId) : null;
    if (configuredAgentId && !configuredAgent) throw new Error("That workspace agent has not been published yet.");
    if (configuredAgent && configuredAgent.baseAgent !== agentKind) throw new Error("The selected agent configuration does not match this specialist.");
    if (configuredAgent && agentKind !== "project" && !configuredAgent.approvedProviders.includes(agentKind)) throw new Error(`The ${configuredAgent.name} configuration is not approved to use ${agentKind}.`);
    const messages = await db.listMessages(workspaceId, conversationId);
    // Diagnostic timing (temporary, 2026-09-21 -- tracking down reports of
    // slow replies since GitHub's MCP tools were added): this covers
    // spawning/reusing the workspace's GitHub MCP Docker container (see
    // github-mcp-pool.ts) -- a real, one-time-per-credential-change cost
    // that's easy to mistake for "the LLM is slow" if you're only
    // watching the chat, not the terminal.
    const buildStart = Date.now();
    // Repositories the GitHub tools actually reached this turn (for "Read as @login · owner/repo").
    const reposUsed = new Set<string>();
    const built = await buildToolsForWorkspace(workspaceId, deps, requestedBy.userId ?? undefined, {
      onGithubRepoUsed: (fullName) => reposUsed.add(fullName),
    });
    console.log(`[timing] workspace ${workspaceId}: buildToolsForWorkspace (incl. GitHub MCP container) took ${Date.now() - buildStart}ms`);
    // Read tools run for real from the agent loop; write tools are
    // swapped for proposal-only stand-ins here -- see actions.ts.
    const specialistTools = agentKind === "github" ? built.githubTools : agentKind === "slack" ? built.slackTools : agentKind === "linear" ? built.linearTools : agentKind === "notion" ? built.notionTools : agentKind === "figma" ? built.figmaTools : [];
    // Reviews and checks are runtime read-only. Workflows that explicitly
    // request a write retain proposal tools, never direct write execution.
    const actingAccount = agentKind === "project" ? undefined : built.accounts[agentKind];
    const tools = wrapForProposal(specialistTools, workspaceId, conversationId, rooms, requestedBy.userId ? { userId: requestedBy.userId, name: requestedBy.name } : undefined, agentKind, {
      readOnly: workflowReadOnly,
      runAs: actingAccount,
      listOpenIssues: built.listOpenIssues,
      allowAutoApprove,
      githubLookups: built.githubLookups,
      slackChannelName: built.slackChannelName,
    });
    // A workflow configured for a specialist is an operational contract: it
    // must have that specialist's connected tool surface. Letting the model
    // write an apologetic text-only reply makes a broken integration look
    // like a successful automation and hides the failure from diagnostics,
    // alerts, and run-health metrics.
    if (workflowInstructions && agentKind !== "project" && tools.length === 0) {
      throw new Error(`${agentKind[0].toUpperCase()}${agentKind.slice(1)} is not connected or has no approved tools for this workflow.`);
    }
    // Cheap, always-on diagnostic -- when someone reports "the agent says
    // it can't see GitHub" the first thing to know is whether the tool
    // list was actually empty for this turn (an integration/credential
    // problem) or non-empty (the model just didn't use what it had).
    console.log(`[agent] workspace ${workspaceId}: ${tools.length} tool(s) available for this turn${workflowInstructions ? ` (workflow ${workflowReadOnly ? "read-only" : "approved-write proposal"})` : ""}`);

    // Confirmation notices are deliberately excluded from normal LLM
    // history (history.ts), so provide the recent authoritative outcomes as
    // compact server context instead. Without this, a follow-up such as
    // "is the action completed?" can only see the earlier proposal and may
    // incorrectly call an already-confirmed action pending.
    const recentActions = (await db.listPendingActions(workspaceId, conversationId))
      .slice(-5)
      .map((action) => `- ${action.description}: ${action.status}`)
      .join("\n");
    const workspaceMemory = await db.workspaceMemoryContext(workspaceId);
    // What teammates and GitHub did recently, so the GitHub agent can point
    // out work that is already done or under way.
    const teamActivity = agentKind === "github" ? formatTeamActivity(await listTeamActivity(workspaceId, { hours: 24, limit: 8 }).catch(() => [])) : null;
    const turnStart = Date.now();
    const allowedModels = (process.env.AGENT_LLM_ALLOWED_MODELS ?? "").split(",").map((model) => model.trim());
    const selectedModel = configuredAgent?.model && configuredAgent.model !== "workspace-default" && allowedModels.includes(configuredAgent.model) ? configuredAgent.model : undefined;
    // Workflow start records are system messages for people to read, and
    // history.ts deliberately excludes system rows from LLM history. Pass
    // the workflow instructions explicitly so an automated turn always has
    // a concrete task, while retaining the configured agent's own rules.
    const workflowGuidance = workflowInstructions
      ? `WORKFLOW INSTRUCTIONS — complete this task for the team:\n${workflowInstructions}\n\nFor this automated run, prefer collection-level read calls. Do not fetch every issue, pull request, or workflow run individually unless the list results require it. Once you have the requested categories, provide the concise report.${workspaceMemory ? " Workspace memory is available for this run. Use it for any policy-based draft and cite the relevant [Memory: title] label. A missing repository only prevents live data; it must never prevent a draft based on saved workspace memory." : " No workspace memory is available for this run. If the task requires a saved policy, say that the policy has not been saved in this workspace."}${workflowReadOnly ? " This is a read-only workflow: do not propose external changes." : " This workflow explicitly requests a governed change: create only a pending approval proposal, never a direct external change. When creating a GitHub issue, use issue_write with method=\"create\"."}`
      : "";
    const activeInstructions = [configuredAgent?.instructions, workflowGuidance].filter(Boolean).join("\n\n");
    const result = await deps.runAgentTurn({
      history: toLlmHistory(messages),
      tools,
      githubContext: agentKind === "github" ? built.githubContext : null,
      githubNotice: agentKind === "github" ? built.githubNotice ?? null : null,
      teamActivity,
      actionContext: recentActions || null,
      agentKind,
      customInstructions: activeInstructions || undefined,
      knowledge: configuredAgent?.knowledge,
      workspaceMemory,
      workflowMode: Boolean(workflowInstructions),
      llmConfig: selectedModel ? resolveLlmConfig({ model: selectedModel }) : undefined,
      // Workflows commonly need one read call per requested category (for
      // example issues, pull requests, branches, and CI runs). Give them a
      // larger but still finite tool-call loop than interactive chat.
      maxTurns: workflowInstructions ? 10 : undefined,
    });
    console.log(`[timing] workspace ${workspaceId}: runAgentTurn (all LLM calls + tool calls, see [timing] lines above) took ${Date.now() - turnStart}ms`);
    const proposedActions = await Promise.all(
      (result.proposedActionIds ?? []).map((actionId) => db.getPendingAction(workspaceId, actionId))
    );
    const resolvedReply = replyForResolvedActions(
      proposedActions.filter((action): action is NonNullable<typeof action> => action !== null),
      agentKind
    );
    // Which account (and repositories) answered, shown under the reply.
    const provenance: MessageProvenance | null =
      actingAccount && agentKind !== "project" && result.toolCallsMade > 0
        ? {
            provider: agentKind,
            via: actingAccount.via,
            actedAsUserId: actingAccount.userId,
            actedAsName: requestedBy.name,
            account: actingAccount.account,
            ...(agentKind === "github"
              ? { repos: reposUsed.size ? [...reposUsed] : built.githubContext ? [`${built.githubContext.owner}/${built.githubContext.repo}`] : [] }
              : {}),
          }
        : null;
    const agentMessage = await db.insertMessage({
      workspaceId,
      conversationId,
      provenance,
      role: "agent",
      authorName: configuredAgent?.name ?? (agentKind === "github" ? "GitHub Agent" : agentKind === "slack" ? "Slack Agent" : agentKind === "linear" ? "Linear Agent" : agentKind === "notion" ? "Notion Agent" : agentKind === "figma" ? "Figma Agent" : "Project Agent"),
      // When the card was confirmed or cancelled before this turn finished,
      // the confirm/cancel path has already posted the outcome. Keep the
      // agent's own explanation (for example, what it could not do) without
      // its stale "awaiting confirmation" wording, and fall back to the
      // generic outcome line only when nothing else is left.
      content: resolvedReply
        ? stripConfirmationBoilerplate(result.reply).trim() || resolvedReply
        : preferWorkspaceMemoryForRepositoryUnavailableWorkflow(result.reply, workspaceMemory, Boolean(workflowInstructions)),
    });
    rooms.broadcast(`${workspaceId}:${conversationId}`, { type: "message", message: agentMessage });
    rooms.broadcast(workspaceId, { type: "workspace_message", message: agentMessage });
    await db.notifyWorkspaceMembers({
      workspaceId,
      conversationId,
      kind: "agent_completed",
      text: "Agent completed a response in the workspace.",
      excludeUserIds: rooms.participants(`${workspaceId}:${conversationId}`).flatMap((participant) => participant.userId ? [participant.userId] : []),
    });
    const output = agentMessage.content;
    const providerTokens = result.providerPromptTokens + result.providerCompletionTokens;
    const estimatedTokens = providerTokens || Math.ceil(((workflowInstructions?.length ?? 0) + output.length) / 4);
    return { toolCalls: result.toolCallsMade, estimatedTokens, estimatedCostUsd: Number((estimatedTokens * 0.00000059).toFixed(6)), providerPromptTokens: providerTokens ? result.providerPromptTokens : null, providerCompletionTokens: providerTokens ? result.providerCompletionTokens : null, providerCostUsd: result.providerCostUsd, outputExcerpt: output.slice(0, 1000), inputExcerpt: workflowInstructions ? workflowInstructions.slice(0, 1000) : null, toolTrace: result.toolTrace };
  }

  // The HTTP routes created by createApp enqueue a workflow through this
  // runner. Keeping the actual agent invocation here means scheduled and
  // event-driven work takes the identical tool, provider-permission, action
  // proposal, notification, and WebSocket paths as an ordinary chat turn.
  const runWorkflow = async (workflow: NonNullable<Awaited<ReturnType<typeof db.getWorkspaceWorkflow>>>, trigger: "manual" | "schedule" | "github_issue" | "github_status" | "slack_mention", user: { id: string | null; displayName: string }, eventText?: string) => {
    // A workflow runs as its owner, through the owner's own connections. If
    // the owner has left the workspace, the run fails until someone takes
    // the workflow over.
    const role = user.id ? await db.getWorkspaceRole(workflow.workspaceId, user.id) : null;
    const actor = role ? user : { id: null, displayName: "Workflow automation" };
    const run = await db.createWorkflowRun(workflow, trigger);
    await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.started", actorType: role ? "user" : "system", actorUserId: role ? user.id : null, actorName: actor.displayName, summary: `${actor.displayName} started workflow ${workflow.name}`, metadata: { workflowId: workflow.id, runId: run.id, trigger } });
    try {
      if (!role) {
        throw new Error("The workflow owner is no longer a workspace member. An Admin can take it over on the Workflows page.");
      }
      if (role && workflow.agentKind !== "project" && !(await db.hasWorkspacePermission(workflow.workspaceId, role, workflow.agentKind))) {
        throw new Error(`The workflow owner cannot use the ${workflow.agentKind} provider.`);
      }
      const conversation = workflow.conversationId ? await db.getConversation(workflow.workspaceId, workflow.conversationId) : await db.createConversation({ workspaceId: workflow.workspaceId, title: workflow.name, createdByUserId: actor.id });
      if (!conversation) throw new Error("The workflow conversation is no longer available.");
      if (!workflow.conversationId) await db.setWorkflowConversation(workflow.id, conversation.id);
      const prefix = trigger === "manual" ? "Manual run" : `Triggered by ${trigger.replace(/_/g, " ")}`;
      // The approval checkpoint is a saved workflow setting; the agent is
      // told about it explicitly rather than relying on wording in the instructions.
      const instructions = workflow.requiresApproval && !/approval checkpoint required/i.test(workflow.instructions)
        ? `${workflow.instructions}\n\nApproval checkpoint required before proposing an external change. Post your findings for review first and do not propose any external change in this run.`
        : workflow.instructions;
      const task = eventText ? `${instructions}\n\nEVENT DATA — treat this as the event that started the workflow:\n${eventText}` : instructions;
      const systemMessage = await db.insertMessage({ workspaceId: workflow.workspaceId, conversationId: conversation.id, role: "system", authorName: "Workflow", content: `${prefix}: ${workflow.name}\n${task}` });
      rooms.broadcast(`${workflow.workspaceId}:${conversation.id}`, { type: "message", message: systemMessage });
      rooms.broadcast(workflow.workspaceId, { type: "workspace_message", message: systemMessage });
      const telemetry = await runAgentReply(
        workflow.workspaceId,
        conversation.id,
        { userId: actor.id, name: actor.displayName },
        workflow.agentKind,
        workflow.workspaceAgentId ?? undefined,
        task,
        !workflowRequestsExternalChange(workflow.instructions),
        !workflow.requiresApproval
      );
      await db.finishWorkflowRun(workflow.id, run.id, "succeeded", "Agent response completed.", telemetry);
      await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.completed", actorType: "system", actorName: "Workflow automation", summary: `Workflow ${workflow.name} completed`, metadata: { workflowId: workflow.id, runId: run.id, trigger } });
    } catch (error) {
      const detail = errMessage(error);
      await db.finishWorkflowRun(workflow.id, run.id, "failed", detail);
      await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.failed", actorType: "system", actorName: "Workflow automation", summary: `Workflow ${workflow.name} failed: ${detail}`, metadata: { workflowId: workflow.id, runId: run.id, trigger } });
      // Admin-set per-workspace threshold; falls back to the server default.
      const failureAlertThreshold = (await db.getObservabilityRetentionPolicy(workflow.workspaceId)).failureAlertThreshold;
      // Count this workflow's own failures so the alert names the workflow
      // that is actually failing repeatedly.
      const recentFailures = await db.countRecentFailedWorkflowRuns(workflow.workspaceId, 24, workflow.id);
      // Alert exactly when the threshold is crossed, rather than spamming
      // everyone on every subsequent failed retry in the same 24-hour window.
      if (recentFailures === failureAlertThreshold) {
        await db.notifyWorkspaceMembers({
          workspaceId: workflow.workspaceId,
          conversationId: workflow.conversationId,
          kind: "workflow_alert",
          text: `Workflow ${workflow.name} failed ${recentFailures} time${recentFailures === 1 ? "" : "s"} in the last 24 hours. Review it in Observability.`,
          priority: "high",
          resourceType: "workflow",
          resourceId: workflow.id,
        });
      }
    }
  };
  // Runs start in the background (Run now, schedules, GitHub/Slack events),
  // so nothing awaits them. A failure the run itself couldn't record, such as
  // the database rejecting the run record, must be logged here: an
  // unhandled rejection would stop the whole server.
  app.locals.runWorkflow = (...args: Parameters<typeof runWorkflow>): Promise<void> =>
    runWorkflow(...args).catch((error) => {
      console.error(`workflow run failed to start or finish: ${args[0].name} (${args[0].id})`, error);
      captureError(error, { where: "workflow-run", workspaceId: args[0].workspaceId, workflowId: args[0].id, trigger: args[1] });
    });

  // A verified GitHub webhook delivery for one workspace: recorded in
  // Activity, pushed live to everyone in the workspace, and used to start
  // workflows with a matching event trigger.
  const handleGithubEvent: GithubEventHandler = async (workspaceId, event, payload, deliveryId) => {
    const summary = summarizeGithubEvent(event, payload as Record<string, any>);
    if (summary.ignore) return;
    const recorded = await db.recordAuditEvent({
      workspaceId,
      eventType: "github.event",
      actorType: "system",
      actorName: event === "ping" ? "GitHub" : `@${summary.actor}`,
      summary: summary.summary,
      metadata: { event, repo: summary.repo, url: summary.url, activity: summary.summary, deliveryId },
    });
    const activity: TeamActivity = { id: recorded.id, source: "github", actorName: recorded.actorName, summary: summary.summary, repo: summary.repo, url: summary.url, createdAt: recorded.createdAt };
    rooms.broadcast(workspaceId, { type: "team_activity", activity });
    if (!summary.trigger) return;
    for (const workflow of await db.listEventWorkflows(workspaceId, summary.trigger)) {
      const owner = workflow.ownerUserId ? await db.getUserById(workflow.ownerUserId) : null;
      void app.locals.runWorkflow(workflow, summary.trigger, { id: owner?.id ?? null, displayName: owner?.displayName ?? "Workflow automation" }, summary.eventText);
    }
  };
  app.locals.handleGithubEvent = handleGithubEvent;

  // Interval scheduling is intentionally modest: database claiming makes it
  // safe for more than one server process, while each execution still goes
  // through the governed workflow runner above.
  let workflowScheduler: NodeJS.Timeout | undefined;
  const startWorkflowScheduler = () => {
    if (workflowScheduler) return;
    workflowScheduler = setInterval(() => {
      void (async () => {
        const due = await db.claimDueWorkflows();
        for (const workflow of due) {
          const owner = workflow.ownerUserId ? await db.getUserById(workflow.ownerUserId) : null;
          // runWorkflow records a failed run when the owner has left the workspace.
          void app.locals.runWorkflow(workflow, "schedule", { id: owner?.id ?? null, displayName: owner?.displayName ?? "Workflow automation" });
        }
      })().catch((error) => {
        console.error("workflow scheduler failed", error);
        captureError(error, { where: "workflow-scheduler" });
      });
    }, 30_000);
  };
  let retentionScheduler: NodeJS.Timeout | undefined;
  let notificationScheduler: NodeJS.Timeout | undefined;
  const enforceRetention = () => void db.runWithAdvisoryLock("workflow-run-retention", () => db.enforceWorkflowRunRetention()).catch((error) => {
    console.error("workflow retention failed", error);
    captureError(error, { where: "workflow-retention" });
  });
  const deliverNotificationJobs = () => void db.runWithAdvisoryLock("notification-delivery", async () => {
    // Approvals expire after ACTION_APPROVAL_TTL_HOURS (24 by default).
    await Promise.all([db.escalateUnreadDecisionNotifications(), db.createDailyNotificationDigests(), expireStaleActions(rooms)]);
  }).catch((error) => {
    console.error("notification scheduler failed", error);
    captureError(error, { where: "notification-scheduler" });
  });
  server.on("listening", () => { startWorkflowScheduler(); enforceRetention(); deliverNotificationJobs(); retentionScheduler = setInterval(enforceRetention, 24 * 60 * 60 * 1000); notificationScheduler = setInterval(deliverNotificationJobs, 5 * 60 * 1000); });
  server.on("close", () => { void roomBus?.close(); if (workflowScheduler) clearInterval(workflowScheduler); if (retentionScheduler) clearInterval(retentionScheduler); if (notificationScheduler) clearInterval(notificationScheduler); workflowScheduler = undefined; retentionScheduler = undefined; notificationScheduler = undefined; });

  wss.on("connection", (ws: WebSocket, req) => {
    if (req.headers.origin && req.headers.origin !== (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")) {
      ws.close(4003, "Untrusted origin");
      return;
    }
    // See the heartbeat setInterval above -- marks this connection alive
    // on open and on every pong, so a dead connection gets pruned instead
    // of lingering (and showing up as a duplicate) in the presence list.
    // ws reports protocol problems (an oversized or malformed frame) as an
    // "error" event and then closes the socket. With no listener, Node
    // treats that event as an uncaught exception and stops the server, so
    // one bad client could disconnect everyone.
    ws.on("error", (error) => {
      console.error(JSON.stringify({ level: "warn", event: "websocket_client_error", error: errMessage(error) }));
    });
    (ws as HeartbeatSocket).isAlive = true;
    ws.on("pong", () => {
      (ws as HeartbeatSocket).isAlive = true;
    });

    // Found live while testing @-mention/handoff routing: the real
    // message handler is only attached once the async setup below
    // (session lookup, workspace lookup, addWorkspaceMember, history
    // send) finishes, but a client is free to send its first chat message
    // the instant ITS OWN "open" event fires -- which can easily win that
    // race, especially on a slow DB round trip. Before this fix, a
    // message sent that early was silently dropped: no listener was
    // registered yet, so `ws.on("message", ...)` never saw it and the
    // client got no error, no echo, nothing. This tiny synchronous
    // listener is attached before any of those awaits run, so nothing can
    // be sent before it exists; it just queues raw frames until the real
    // handler below replaces it and flushes the queue in order.
    const earlyMessages: Buffer[] = [];
    let handleMessage: ((raw: Buffer) => void) | null = null;
    ws.on("message", (raw: Buffer) => {
      if (handleMessage) handleMessage(raw);
      else earlyMessages.push(raw);
    });

    void (async () => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workspaceId = url.searchParams.get("workspaceId") ?? "";
      const conversationId = url.searchParams.get("conversationId") ?? "";
      const sessionToken = parseSessionToken(req.headers.cookie);
      const user = sessionToken ? await db.getUserBySessionToken(sessionToken) : null;
      if (!user) {
        ws.close(4001, "Sign in required");
        return;
      }
      const displayName = user.displayName;

      if (!UUID_RE.test(workspaceId) || !UUID_RE.test(conversationId)) {
        ws.close(4000, "workspaceId and conversationId are required");
        return;
      }
      const workspace = await db.getWorkspaceById(workspaceId);
      if (!workspace) {
        ws.close(4004, "workspace not found");
        return;
      }
      if (!(await db.getConversation(workspaceId, conversationId))) {
        ws.close(4004, "conversation not found");
        return;
      }
      const roomId = `${workspaceId}:${conversationId}`;

      // Live chat is for existing members only. Membership comes from
      // creating the workspace, joining with its code, or an invitation.
      if (!(await db.getWorkspaceRole(workspaceId, user.id))) {
        ws.close(4003, "Join this workspace with its code or an invitation first");
        return;
      }
      const participant: Participant = { clientId: randomUUID(), userId: user.id, displayName, connectedAt: new Date().toISOString(), activeConversationId: conversationId };
      rooms.join(workspaceId, ws, participant);
      rooms.join(roomId, ws, participant);

      const history = await db.listMessages(workspaceId, conversationId);
      ws.send(JSON.stringify({ type: "history", messages: history }));
      rooms.broadcast(roomId, { type: "presence", participants: rooms.participants(roomId) });
      rooms.broadcast(workspaceId, { type: "workspace_presence", participants: rooms.participants(workspaceId) });

      handleMessage = (raw: Buffer) => {
        void (async () => {
          if (!sessionToken || !(await db.getUserBySessionToken(sessionToken))) {
            ws.close(4001, "Sign in required");
            return;
          }
          let parsed: { type?: string; content?: string; agentKind?: AgentKind; agentId?: string };
          try {
            parsed = JSON.parse(raw.toString());
          } catch {
            ws.send(JSON.stringify({ type: "error", error: "invalid JSON" }));
            return;
          }
          if (parsed.type !== "chat" || typeof parsed.content !== "string" || !parsed.content.trim()) {
            ws.send(JSON.stringify({ type: "error", error: "expected {type: 'chat', content: string}" }));
            return;
          }
          const content = parsed.content.trim();
          if (content.length > MAX_CHAT_MESSAGE_CHARS) {
            ws.send(JSON.stringify({ type: "error", error: `Messages can be at most ${MAX_CHAT_MESSAGE_CHARS.toLocaleString("en-US")} characters. Share longer text as an artifact or a file in a connected tool.` }));
            return;
          }
          const agentKind: AgentKind = parsed.agentKind === "github" || parsed.agentKind === "slack" || parsed.agentKind === "linear" || parsed.agentKind === "notion" || parsed.agentKind === "figma" || parsed.agentKind === "project"
            ? parsed.agentKind
            : /@github\b/i.test(content) ? "github" : /@slack\b/i.test(content) ? "slack" : "project";
          // Re-read the role each message so a role change applies immediately.
          const workspaceRole = await db.getWorkspaceRole(workspaceId, user.id);
          if (!workspaceRole) {
            ws.send(JSON.stringify({ type: "error", error: "You are no longer a member of this workspace." }));
            return;
          }
          if (agentKind !== "project" && !(await db.hasWorkspacePermission(workspaceId, workspaceRole, agentKind))) {
            ws.send(JSON.stringify({ type: "error", error: `Your workspace role cannot use the ${agentKind} provider.` }));
            return;
          }

          // @-mention / handoff mechanics (docs/spec.md Phase 2). Matched
          // against real workspace membership, not just who's currently
          // online, so @-mentioning an offline teammate still resolves --
          // see listWorkspaceMembers's own comment. A message that
          // @-mentions ONLY teammate(s), never the agent, is a handoff:
          // it's still a normal chat message (inserted/broadcast exactly
          // like any other, below), it just never starts an agent turn.
          const members = await db.listWorkspaceMembers(workspaceId);
          const mentions = parseMentions(
            content,
            members.map((m) => ({ userId: m.id, displayName: m.displayName }))
          );

          // Only one agent turn runs at a time per workspace -- everyone
          // shares this chat, and a second message arriving mid-turn would
          // have the agent read an incomplete/interleaved history and
          // could double-fire the same mutating tool. The UI already
          // disables the composer for everyone in the room while busy (see
          // the agent_status broadcast below); this is the server-side
          // backstop for a genuine race (e.g. a second tab, or a message
          // already in flight the instant busy became true). A handoff
          // message (mentions.mentionsAgent === false) never touches the
          // agent at all, so it's exempt -- no reason to make someone wait
          // to hand a task to a teammate just because the agent happens to
          // be busy on something else.
          if (mentions.mentionsAgent && !(await rooms.tryAcquireAgentTurn(roomId))) {
            ws.send(JSON.stringify({ type: "error", error: "The agent is still working on the previous request. Please wait for it to finish." }));
            return;
          }
          // Counted only once the turn is actually starting, so a "still
          // busy" rejection above never uses up someone's allowance.
          if (mentions.mentionsAgent) {
            const allowed = await db.consumeRateLimit("agent-turn-user", user.id, agentTurnsPerUserPerHour(), 60 * 60)
              .catch(async (error) => {
                await rooms.releaseAgentTurn(roomId).catch(() => undefined);
                throw error;
              });
            if (!allowed) {
              await rooms.releaseAgentTurn(roomId);
              ws.send(JSON.stringify({ type: "error", error: "You've reached the hourly limit for agent requests. Please try again later, or hand this off to a teammate with an @mention." }));
              return;
            }
          }

          // If saving the message fails, give the agent-turn lock back so the
          // conversation is not left looking busy.
          const userMessage = await db.insertMessage({
            workspaceId,
            conversationId,
            role: "user",
            authorName: displayName,
            userId: user.id,
            content,
            mentionsAgent: mentions.mentionsAgent,
            mentionedUserIds: mentions.mentionedUserIds,
          }).catch(async (error) => {
            if (mentions.mentionsAgent) await rooms.releaseAgentTurn(roomId).catch(() => undefined);
            throw error;
          });
          rooms.broadcast(roomId, { type: "message", message: userMessage });
          rooms.broadcast(workspaceId, { type: "workspace_message", message: userMessage });

          if (!mentions.mentionsAgent) {
            // Handed off, not addressed to the agent -- log it to the
            // audit trail (docs/spec.md: "so who's driving this stays
            // visible") and stop here; no agent turn to run.
            const handoffNames = members.filter((m) => mentions.mentionedUserIds.includes(m.id)).map((m) => m.displayName);
            await db.recordAuditEvent({
              workspaceId,
              eventType: "handoff.directed",
              actorType: "user",
              actorUserId: user.id,
              actorName: displayName,
              summary: `${displayName} handed off to ${handoffNames.join(", ") || "a teammate"}: ${content}`,
              metadata: { mentionedUserIds: mentions.mentionedUserIds },
            });
            return;
          }

          rooms.broadcast(roomId, { type: "agent_status", status: "busy" });

          // Not awaited from the outer handler -- the sender's own message
          // is never delayed waiting on the agent -- but internally this
          // IIFE does wait for the turn to finish so the busy flag (and its
          // matching "idle" broadcast) always clears, success or failure,
          // via the finally below.
          (async () => {
            try {
              await runAgentReply(workspaceId, conversationId, { userId: user.id, name: displayName }, agentKind, typeof parsed.agentId === "string" && UUID_RE.test(parsed.agentId) ? parsed.agentId : undefined);
            } catch (err) {
              console.error("agent turn failed", err);
              captureError(err, { where: "agent-turn", workspaceId, conversationId, agentKind });
              const errorMessage = await db.insertMessage({
                workspaceId,
                conversationId,
                role: "system",
                authorName: "System",
                content: `The agent couldn't reply: ${errMessage(err)}`,
              });
              rooms.broadcast(roomId, { type: "message", message: errorMessage });
              rooms.broadcast(workspaceId, { type: "workspace_message", message: errorMessage });
            } finally {
              await rooms.releaseAgentTurn(roomId).catch((error) => console.error("agent turn lock release failed", error));
              rooms.broadcast(roomId, { type: "agent_status", status: "idle" });
            }
          })().catch((error) => {
            console.error("agent turn cleanup failed", error);
            captureError(error, { where: "agent-turn-cleanup", workspaceId, conversationId });
          });
        })().catch((error) => {
          // Without this, any failed database call above (saving the
          // message, reading membership, ...) became an unhandled promise
          // rejection, which terminates the whole Node process and drops
          // every connected user. Report it to this sender only.
          console.error("chat message handling failed", error);
          captureError(error, { where: "chat-message", workspaceId, conversationId });
          sendSafely(ws, { type: "error", error: "Your message couldn't be sent. Please try again." });
        });
      };
      // Replay, in order, anything that arrived before this handler was
      // ready -- see the earlyMessages comment above.
      for (const raw of earlyMessages) handleMessage(raw);
      earlyMessages.length = 0;

      ws.on("close", () => {
        rooms.leave(roomId, ws);
        rooms.leave(workspaceId, ws);
        rooms.broadcast(roomId, { type: "presence", participants: rooms.participants(roomId) });
        rooms.broadcast(workspaceId, { type: "workspace_presence", participants: rooms.participants(workspaceId) });
      });
    })().catch((error) => {
      // A database failure while setting up the connection must close this
      // one socket, not crash the server for everyone.
      console.error("chat connection setup failed", error);
      captureError(error, { where: "chat-connection" });
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1011, "Server error, please reconnect");
    });
  });

  app.use((error: unknown, req: Request, res: Response, _next: express.NextFunction) => {
    const requestId = res.getHeader("x-request-id");
    // Body-parser failures (malformed JSON, oversized or unsupported bodies)
    // are the client's mistake: answer with their 4xx status, not a 500.
    const clientStatus = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 0;
    if (clientStatus >= 400 && clientStatus < 500) {
      if (!res.headersSent) res.status(clientStatus).json({ error: clientStatus === 413 ? "Request body is too large." : "The request body could not be read. Send valid JSON." });
      return;
    }
    console.error(JSON.stringify({ level: "error", event: "unhandled_http_error", requestId, method: req.method, path: req.path, error: errMessage(error) }));
    captureError(error, { where: "http", method: req.method, route: req.route?.path ?? req.path, requestId: typeof requestId === "string" ? requestId : null });
    if (!res.headersSent) res.status(500).json({ error: "Unexpected server error", requestId });
  });

  return {
    app,
    server,
    rooms,
    start(port: number) {
      server.listen(port);
      console.log(`chat-server listening on :${port}`);
      return server;
    },
  };
}
