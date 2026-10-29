// Grounded drafts for artifacts (dashboard snapshot, release notes, report, assisted and AI drafts).
import * as db from "@mai-chat/db";
import { errMessage } from "./http-utils.js";
import { resolveLlmConfig } from "./llm-client.js";
import type { CreateServerDeps } from "./server-deps.js";

export async function workspaceDashboardSnapshot(workspaceId: string, deps: CreateServerDeps, requestingUserId?: string) {
  const [integrations, workflows, members, conversations, recentAudit] = await Promise.all([
    db.listIntegrations(workspaceId), db.listWorkspaceWorkflows(workspaceId), db.listWorkspaceMembers(workspaceId), db.listConversations(workspaceId),
    db.listAuditEvents(workspaceId, { eventType: "action.failed", limit: 10 }),
  ]);
  const pendingActions = (await Promise.all(conversations.map((conversation) => db.listPendingActions(workspaceId, conversation.id, true)))).flat();
  const activeWorkflows = workflows.filter((workflow) => workflow.enabled);
  const failedWorkflows = workflows.filter((workflow) => workflow.lastRunStatus === "failed");
  const failedActions = recentAudit;

  // Real, live GitHub numbers when a repo is connected -- not just a
  // count of *that* connection, but what it's actually reporting right
  // now. Verification-only client (see integrations/github.ts), so a
  // dead/revoked token degrades this one metric rather than the whole
  // dashboard: caught and treated as "no data" instead of failing the
  // refresh.
  const githubIntegration = integrations.find((integration): integration is Extract<typeof integrations[number], { type: "github" }> => integration.type === "github" && integration.ownerUserId === requestingUserId && Boolean(integration.owner) && Boolean(integration.repo));
  let openGithubIssues: number | null = null;
  if (githubIntegration?.id && githubIntegration.owner && githubIntegration.repo) {
    try {
      const credential = await db.getIntegrationCredential(workspaceId, "github", githubIntegration.id);
      if (credential) {
        const issues = await deps.githubClientFactory({ token: credential.token, owner: githubIntegration.owner, repo: githubIntegration.repo }).listIssues("open", 50);
        openGithubIssues = issues.length;
      }
    } catch {
      // Token revoked, repo renamed, rate-limited, etc. -- leave the
      // metric out rather than failing the whole dashboard refresh.
      openGithubIssues = null;
    }
  }

  // off_track is for when something is actually broken right now (a
  // repeatedly failing action, not just a stale workflow) -- at_risk
  // covers the softer "nothing connected yet" / "one workflow failing"
  // cases the health badge already handled.
  const health: "on_track" | "at_risk" | "off_track" =
    failedActions.length >= 3 ? "off_track" : failedWorkflows.length || failedActions.length ? "at_risk" : integrations.length ? "on_track" : "at_risk";

  const risks = [
    ...failedActions.slice(0, 3).map((event) => ({ id: `audit-${event.id}`, title: event.summary, severity: "high" as const, owner: event.actorName })),
    ...failedWorkflows.slice(0, 3).map((workflow) => ({ id: `workflow-${workflow.id}`, title: `Workflow failed: ${workflow.name}${workflow.lastRunError ? ` — ${workflow.lastRunError.slice(0, 90)}` : ""}`, severity: "high" as const, owner: "Workflow owner" })),
    ...(integrations.length ? [] : [{ id: "connections", title: "No connected tool is available for live workspace data", severity: "medium" as const, owner: "Workspace Admin" }]),
  ];
  const metrics = [
    { id: "tools", label: "Connected tools", value: String(integrations.length), trend: "flat" as const, target: "At least 1" },
    { id: "workflows", label: "Active workflows", value: String(activeWorkflows.length), trend: "flat" as const, target: "Configured" },
    { id: "approvals", label: "Pending approvals", value: String(pendingActions.length), trend: pendingActions.length ? "up" as const : "flat" as const, target: "0" },
    { id: "members", label: "Team members", value: String(members.length), trend: "flat" as const, target: "Collaborating" },
    ...(openGithubIssues === null ? [] : [{ id: "github-issues", label: "Open GitHub issues/PRs", value: String(openGithubIssues), trend: "flat" as const, target: "Triaged" }]),
  ];
  return { health, metrics, milestones: [
    { id: "workflow-health", label: "Workflow reliability", progress: activeWorkflows.length ? Math.round(((activeWorkflows.length - failedWorkflows.length) / activeWorkflows.length) * 100) : 0 },
    { id: "workspace-ready", label: "Workspace readiness", progress: Math.min(100, (integrations.length ? 50 : 0) + (activeWorkflows.length ? 30 : 0) + (members.length > 1 ? 20 : 0)) },
  ], risks, decisions: pendingActions.slice(0, 3).map((action) => ({ id: `approval-${action.id}`, title: action.description, owner: action.requestedByName ?? "Workspace Admin", dueDate: "" })), checklist: [
    { id: "integration", label: "Connect at least one workspace tool", done: integrations.length > 0 },
    { id: "workflow", label: "Enable an automation workflow", done: activeWorkflows.length > 0 },
    { id: "approvals", label: "Resolve pending approval requests", done: pendingActions.length === 0 },
  ] };
}

// Drafts a Release Notes artifact's content from real GitHub activity --
// merged PRs since the last published release note (or the last 30 days,
// if there isn't one) become Highlights, closed issues in that window
// become Fixes, and open bug-labeled issues become Known issues. Every
// line links back to the actual PR/issue and credits its author, so the
// draft isn't just prose -- see the "Generate from GitHub" button in
// apps/web's artifacts page. A person still edits this before publishing;
// it's a draft, not a silent auto-publish.
export async function workspaceReleaseNotesDraft(workspaceId: string, artifactId: string, deps: CreateServerDeps, requestingUserId?: string): Promise<string> {
  const [integrations, existingArtifacts] = await Promise.all([db.listIntegrations(workspaceId), db.listWorkspaceArtifacts(workspaceId)]);
  const githubIntegration = integrations.find(
    (integration): integration is Extract<typeof integrations[number], { type: "github" }> =>
      integration.type === "github" && integration.ownerUserId === requestingUserId && Boolean(integration.owner) && Boolean(integration.repo)
  );
  const previousRelease = existingArtifacts
    .filter((artifact) => artifact.type === "release_notes" && artifact.status === "published" && artifact.id !== artifactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const since = previousRelease ? new Date(previousRelease.createdAt) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sinceLabel = since.toISOString().slice(0, 10);

  if (!githubIntegration?.id || !githubIntegration.owner || !githubIntegration.repo) {
    return `## Highlights

_No GitHub repo is connected to this workspace yet -- connect one in Integrations to auto-generate this from merged PRs and closed issues._

## Fixes

## Known issues
`;
  }
  const credential = await db.getIntegrationCredential(workspaceId, "github", githubIntegration.id);
  if (!credential) {
    return `## Highlights

_GitHub's connection needs to be re-authorized before this can be generated._

## Fixes

## Known issues
`;
  }
  const client = deps.githubClientFactory({ token: credential.token, owner: githubIntegration.owner, repo: githubIntegration.repo });
  try {
    const [pulls, closedIssues, openIssues] = await Promise.all([
      client.listPullRequests("closed", 50),
      client.listIssues("closed", 50),
      client.listIssues("open", 50),
    ]);
    const mergedPrs = pulls.filter((pr) => pr.merged && new Date(pr.updatedAt) >= since);
    const fixedIssues = closedIssues.filter((issue) => new Date(issue.updatedAt) >= since);
    const knownIssues = openIssues.filter((issue) => issue.labels.some((label) => /bug/i.test(label))).slice(0, 10);

    const highlightLines = mergedPrs.length
      ? mergedPrs.map((pr) => `- ${pr.title} ([#${pr.number}](${pr.url})) by @${pr.author}`).join("\n")
      : "_No PRs merged since the last release._";
    const fixLines = fixedIssues.length
      ? fixedIssues.map((issue) => `- ${issue.title} ([#${issue.number}](${issue.url})) by @${issue.author}`).join("\n")
      : "_No issues closed since the last release._";
    const knownLines = knownIssues.length
      ? knownIssues.map((issue) => `- ${issue.title} ([#${issue.number}](${issue.url}))`).join("\n")
      : "_No open bugs flagged right now._";

    return `## Highlights
${highlightLines}

## Fixes
${fixLines}

## Known issues
${knownLines}

_Generated from ${githubIntegration.owner}/${githubIntegration.repo} activity since ${sinceLabel}._`;
  } catch (err) {
    return `## Highlights

_Could not reach GitHub to generate this: ${errMessage(err)}_

## Fixes

## Known issues
`;
  }
}

// Drafts a Report artifact's content from the workspace's own recent
// activity (the audit trail, integrations, and membership) -- since the
// last published report for this workspace, or the last 7 days if there
// isn't one. Same "draft, don't silently publish" contract as the release
// notes generator above: a person still reviews and edits this.
export async function workspaceReportDraft(workspaceId: string, artifactId: string): Promise<string> {
  const existingArtifacts = await db.listWorkspaceArtifacts(workspaceId);
  const previousReport = existingArtifacts
    .filter((artifact) => artifact.type === "report" && artifact.status === "published" && artifact.id !== artifactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const since = previousReport ? new Date(previousReport.createdAt) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sinceLabel = since.toISOString().slice(0, 10);

  const [recentEvents, members, integrations] = await Promise.all([
    db.listAuditEvents(workspaceId, { limit: 200 }),
    db.listWorkspaceMembers(workspaceId),
    db.listIntegrations(workspaceId),
  ]);
  const windowEvents = recentEvents.filter((event) => new Date(event.createdAt) >= since);
  const confirmed = windowEvents.filter((event) => event.eventType === "action.confirmed");
  const failed = windowEvents.filter((event) => event.eventType === "action.failed");
  const joined = windowEvents.filter((event) => event.eventType === "member.joined");
  const connected = windowEvents.filter((event) => event.eventType === "integration.connected");
  const stillPending = recentEvents.filter((event) => event.eventType === "action.proposed").length
    - recentEvents.filter((event) => event.eventType === "action.confirmed" || event.eventType === "action.cancelled" || event.eventType === "action.failed").length;

  const progressItems = [
    `${confirmed.length} agent action${confirmed.length === 1 ? "" : "s"} confirmed and completed`,
    ...(joined.length ? [`${joined.length} new team member${joined.length === 1 ? "" : "s"} joined (${members.length} total now)`] : []),
    ...(connected.length ? [`${connected.length} new tool connection${connected.length === 1 ? "" : "s"}: ${connected.map((event) => event.summary).slice(0, 5).join("; ")}`] : []),
    ...(confirmed.length === 0 && joined.length === 0 && connected.length === 0 ? ["No recorded activity in this window."] : []),
  ];
  const riskItems = failed.length ? failed.slice(0, 5).map((event) => event.summary) : ["_No failed actions in this window._"];
  const nextStepItems = [
    ...(stillPending > 0 ? [`${stillPending} pending approval${stillPending === 1 ? "" : "s"} still awaiting a decision`] : []),
    ...(integrations.length === 0 ? ["Connect a tool (GitHub or Slack) so future reports have real activity to summarize"] : []),
    ...(stillPending <= 0 && integrations.length > 0 ? ["No blocking follow-ups identified -- add anything the team should know here."] : []),
  ];
  const bullets = (items: string[]) => items.map((item) => `- ${item}`).join(String.fromCharCode(10));

  return [
    "## Progress",
    bullets(progressItems),
    "",
    "## Risks",
    bullets(riskItems),
    "",
    "## Next step",
    bullets(nextStepItems),
    "",
    `_Generated from this workspace's activity since ${sinceLabel}._`,
  ].join(String.fromCharCode(10));
}


export async function workspaceAssistedArtifactDraft(workspaceId: string, artifact: Awaited<ReturnType<typeof db.getWorkspaceArtifact>>, prompt: string) {
  if (!artifact) return "";
  if (artifact.type === "report") return workspaceReportDraft(workspaceId, artifact.id);
  if (artifact.type === "release_notes") return "";
  const [memories, events, workflows, integrations, members] = await Promise.all([
    db.listWorkspaceMemory(workspaceId), db.listAuditEvents(workspaceId, { limit: 30 }), db.listWorkspaceWorkflows(workspaceId), db.listIntegrations(workspaceId), db.listWorkspaceMembers(workspaceId),
  ]);
  const memoryLines = memories.slice(0, 5).map((memory) => `- ${memory.title}: ${memory.content.replace(/\s+/g, " ").slice(0, 180)}`);
  const eventLines = events.slice(0, 6).map((event) => `- ${event.summary}`);
  const workflowLines = workflows.filter((workflow) => workflow.enabled).slice(0, 5).map((workflow) => `- ${workflow.name}${workflow.lastRunStatus ? ` (${workflow.lastRunStatus})` : ""}`);
  const contextNote = prompt.trim() ? `\n_Requested focus: ${prompt.trim().slice(0, 500)}_\n` : "";
  const failureLines = events.filter((event) => event.eventType === "action.failed").slice(0, 3).map((event) => `- ${event.summary}`);
  if (artifact.type === "plan") return [
    "## Goal", prompt.trim() || artifact.summary || "Define the outcome this workspace should achieve.", "",
    "## Scope", "- Use the workspace context below to confirm what is in and out of scope.", "",
    "## Workstreams", ...(workflowLines.length ? workflowLines : ["- Establish the primary workstream and owner."]), "",
    "## Milestones", "- [ ] Confirm scope and owners — Owner: Workspace Admin — Due: ", "- [ ] Review progress and risks — Owner:  — Due: ", "",
    "## Risks", ...(failureLines.length ? failureLines : ["- No recorded failures. Review connected tools and open approvals."]), "",
    "## Success metrics", `- Connected tools: ${integrations.length}`, `- Active workflows: ${workflows.filter((workflow) => workflow.enabled).length}`, `- Team members: ${members.length}`, "",
    "## Workspace memory", ...(memoryLines.length ? memoryLines : ["- No saved workspace memory yet."]), contextNote,
  ].join("\n");
  if (artifact.type === "task_list") return [
    "## Priority tasks", "- [ ] Confirm the intended outcome — Owner:  — Due: ", "- [ ] Review workspace memory and decisions — Owner:  — Due: ", ...(integrations.length ? [] : ["- [ ] Connect a workspace tool for live context — Owner: Workspace Admin — Due: "]), ...(workflows.filter((workflow) => workflow.enabled).length ? [] : ["- [ ] Enable the recurring workflow needed for this work — Owner:  — Due: "]), "",
    "## Follow-up from recent activity", ...(eventLines.length ? eventLines.map((event) => event.replace(/^- /, "- [ ] ")) : ["- [ ] No recent activity to triage."]), "",
    "## Dependencies", "- [ ] Confirm dependencies and handoffs — Owner:  — Due: ", "",
    "## Context", ...(memoryLines.length ? memoryLines : ["- No saved workspace memory yet."]), contextNote,
  ].join("\n");
  return artifact.content;
}


export async function aiArtifactDraft(workspaceId: string, artifact: NonNullable<Awaited<ReturnType<typeof db.getWorkspaceArtifact>>>, prompt: string, deps: CreateServerDeps): Promise<string> {
  const sourceDraft = artifact.type === "release_notes"
    ? await workspaceReleaseNotesDraft(workspaceId, artifact.id, deps)
    : await workspaceAssistedArtifactDraft(workspaceId, artifact, prompt);
  const workspaceMemory = await db.workspaceMemoryContext(workspaceId);
  const request = [
    `Create a polished ${artifact.type.replace("_", " ")} for the shared workspace.`,
    "Return only the artifact in Markdown. Do not mention being an AI, this prompt, unavailable tools, or any drafting process.",
    "Use only facts in the existing notes and context, grounded source draft, and saved workspace memory. Preserve relevant details from existing notes; improve their organization but do not invent facts, owners, dates, metrics, or completed work.",
    prompt.trim() ? `The user wants this focus: ${prompt.trim().slice(0, 500)}` : "Use the artifact title and summary as the intended focus.",
    `Artifact title: ${artifact.title}`,
    artifact.summary ? `Artifact summary: ${artifact.summary}` : "",
    artifact.content.trim() ? "Existing notes and context — retain relevant details from this material:\n" + artifact.content.trim().slice(0, 12_000) : "",
    "Grounded source draft:", sourceDraft,
  ].filter(Boolean).join("\n\n");
  const result = await deps.runAgentTurn({
    history: [{ role: "user", content: request }],
    tools: [],
    agentKind: "project",
    customInstructions: "You are writing a shared workspace artifact. Produce complete, useful Markdown with clear headings, concise bullets, and checklist items where appropriate. Do not propose or perform external actions.",
    workspaceMemory,
    maxTurns: 1,
    llmConfig: resolveLlmConfig({ maxTokens: 1400 }),
  });
  const content = result.reply.trim();
  const tokens = result.providerPromptTokens + result.providerCompletionTokens || Math.ceil((request.length + content.length) / 4);
  await db.recordWorkspaceTokenUsage(workspaceId, tokens).catch(() => undefined);
  if (!content) throw new Error("The AI model returned an empty draft.");
  return content;
}
