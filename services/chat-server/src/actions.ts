import type { Express, NextFunction, Request, Response } from "express";
import { captureError } from "./error-tracking.js";
import * as db from "@mai-chat/db";
import type { RoomRegistry } from "./rooms.js";
import type { ToolExecutor } from "./tools.js";
import { UUID_RE, paramString, errMessage } from "./http-utils.js";
import type { CreateServerDeps } from "./server.js";
import { getRemoteMcpClient } from "./remote-mcp-pool.js";
import { listMcpToolExecutors } from "./mcp-tools.js";
import { buildNotionTools } from "./notion-tools.js";
import { buildFigmaTools } from "./figma-tools.js";
import type { IntegrationType, PendingAction, TeamActivity } from "@mai-chat/shared-types";
import { offlineGithubTeamApi, type GithubChangedFile, type GithubTeamApi, type RepoAccess } from "./github-api.js";
import { describeActionTarget, findActionWarnings, guardGithubTools, providerForTool, type GithubWorkspaceContext } from "./github-team.js";
import { actionFacts, evaluateApprovalRules, isSlackId, standingScope } from "./approval-rules.js";
import type { ActionTarget, ChangePreview, ProposalContext, StandingApproval } from "@mai-chat/shared-types";
import { buildChangePreview, fullText } from "./change-preview.js";

type ActionAgentKind = "project" | "github" | "slack" | "linear" | "notion" | "figma";

function completionAgentFor(agentKind: ActionAgentKind | null | undefined, toolName: string): string {
  if (agentKind === "project") return "Project Agent";
  if (agentKind === "github") return "GitHub Agent";
  if (agentKind === "slack") return "Slack Agent";
  if (agentKind === "linear") return "Linear Agent";
  if (agentKind === "notion") return "Notion Agent";
  if (agentKind === "figma") return "Figma Agent";
  // Legacy pending actions predate agent_kind. Retain a best-effort label
  // for them without changing their recorded request.
  if (toolName.startsWith("slack_")) return "Slack Agent";
  if (toolName.startsWith("linear_")) return "Linear Agent";
  if (toolName.startsWith("notion_")) return "Notion Agent";
  if (toolName.startsWith("figma_")) return "Figma Agent";
  // The remaining mutating tools in the current workspace surface come
  // from GitHub MCP (issue_write, create_pull_request, file writes, etc.).
  return "GitHub Agent";
}

export interface ProviderAccount {
  // Every connection belongs to one member; actions run as that member.
  via: "user";
  userId: string | null;
  // Provider account name, e.g. a GitHub username.
  account: string | null;
}

export interface WorkspaceTools {
  tools: ToolExecutor[];
  githubTools: ToolExecutor[];
  slackTools: ToolExecutor[];
  linearTools: ToolExecutor[];
  notionTools: ToolExecutor[];
  figmaTools: ToolExecutor[];
  // Set when GitHub tools were loaded: the member's one repository, what
  // their account can do there, and who the tools act as. agent.ts tells the
  // model which owner/repo to pass, since GitHub's MCP tools take both on
  // every call.
  githubContext?: GithubWorkspaceContext;
  // Set when this member connected GitHub but hasn't chosen a repository,
  // so the agent can say what to do instead of guessing.
  githubNotice?: string;
  // The account each provider's tools act as this turn.
  accounts: Partial<Record<IntegrationType, ProviderAccount>>;
  // Open issues in a repository, read with the same account (duplicate checks).
  listOpenIssues?: (owner: string, repo: string) => Promise<Array<{ number: number; title: string; url: string }>>;
  // Read with the same accounts, for approval rules: which branch a GitHub
  // action lands on and what GitHub requires there, and Slack channel names.
  githubLookups?: GithubLookups;
  slackChannelName?: (channelId: string) => Promise<string | null>;
  // Channel IDs for "#name" mentions, from Slack's channel list.
  findSlackChannels?: (names: string[]) => Promise<Record<string, string | null>>;
}

export interface GithubLookups {
  pullRequestBase(owner: string, repo: string, number: number): Promise<string | null>;
  defaultBranch(owner: string, repo: string): Promise<string | null>;
  branchProtection(owner: string, repo: string, branch: string): Promise<{ protected: boolean; requiredReviews: number | null } | null>;
  // For change previews (change-preview.ts). Optional so tests can omit them.
  fileText?(owner: string, repo: string, path: string, ref: string | null): Promise<{ exists: true; text: string } | { exists: false } | null>;
  pullRequest?(owner: string, repo: string, number: number): Promise<{ title: string; body: string; head: string; base: string; state: string } | null>;
  changedFiles?(owner: string, repo: string, which: { pullNumber: number } | { base: string; head: string }): Promise<GithubChangedFile[] | null>;
  issue?(owner: string, repo: string, number: number): Promise<{ title: string; body: string; state: string; labels: string[] } | null>;
}

export interface BuildToolsOptions {
  // Called with "owner/repo" whenever a GitHub tool call reaches the repository.
  onGithubRepoUsed?: (fullName: string) => void;
}

export function teamApiFor(deps: CreateServerDeps): GithubTeamApi {
  return deps.githubTeamApi ?? offlineGithubTeamApi;
}

// Builds the full read+write tool set for whatever's connected to a
// workspace. Shared by the agent loop (server.ts's runAgentReply, which
// wraps the mutating ones via wrapForProposal below before handing them to
// the LLM) and by the confirm route below (which needs the SAME tools,
// unwrapped, to actually run one once a human approves it).
export async function buildToolsForWorkspace(workspaceId: string, deps: CreateServerDeps, requestingUserId?: string, options: BuildToolsOptions = {}): Promise<WorkspaceTools> {
  const available = await db.listIntegrations(workspaceId);
  const api = teamApiFor(deps);
  // A member can work only through a connection they own. This preserves
  // source access boundaries even though every member can see the connected
  // account directory in the workspace UI.
  const integrations = (["github", "slack", "linear", "notion", "figma"] as const).flatMap((type) => {
    const accounts = available.filter((integration) => integration.type === type);
    const owned = accounts.find((integration) => integration.ownerUserId === requestingUserId);
    return owned ? [owned] : [];
  });
  const tools: ToolExecutor[] = [];
  const githubAgentTools: ToolExecutor[] = [];
  const slackAgentTools: ToolExecutor[] = [];
  const remoteAgentTools: Record<"linear" | "notion" | "figma", ToolExecutor[]> = { linear: [], notion: [], figma: [] };
  const accounts: WorkspaceTools["accounts"] = {};
  let githubContext: GithubWorkspaceContext | undefined;
  let githubNotice: string | undefined;
  let listOpenIssues: WorkspaceTools["listOpenIssues"];
  let githubLookups: GithubLookups | undefined;
  let slackChannelName: WorkspaceTools["slackChannelName"];
  let findSlackChannels: WorkspaceTools["findSlackChannels"];
  const actingUser = requestingUserId ? await db.getUserById(requestingUserId) : null;

  // GitHub: the one repository this member chose, through their own account.
  const loadGithub = async (token: string, account: string | null, owner: string, repo: string) => {
    try {
      const githubTools = await deps.githubMcpToolsFactory({ workspaceId, token, accountKey: requestingUserId });
      const access: RepoAccess = await api.getRepoAccess(token, owner, repo).catch((): RepoAccess => "unknown");
      githubContext = { owner, repo, access, account, actingAs: actingUser?.displayName ?? "this member" };
      const guarded = guardGithubTools(githubTools, githubContext, options.onGithubRepoUsed);
      tools.push(...guarded);
      githubAgentTools.push(...guarded);
      accounts.github = { via: "user", userId: requestingUserId ?? null, account };
      listOpenIssues = (issueOwner, issueRepo) => api.listOpenIssues(token, issueOwner, issueRepo);
      githubLookups = {
        pullRequestBase: async (lookupOwner, lookupRepo, number) => (api.getPullRequestBase ? api.getPullRequestBase(token, lookupOwner, lookupRepo, number) : null),
        defaultBranch: async (lookupOwner, lookupRepo) => (api.getDefaultBranch ? api.getDefaultBranch(token, lookupOwner, lookupRepo) : null),
        branchProtection: async (lookupOwner, lookupRepo, branch) => (api.getBranchProtection ? api.getBranchProtection(token, lookupOwner, lookupRepo, branch) : null),
        fileText: async (lookupOwner, lookupRepo, path, ref) => (api.getFileText ? api.getFileText(token, lookupOwner, lookupRepo, path, ref) : null),
        pullRequest: async (lookupOwner, lookupRepo, number) => (api.getPullRequest ? api.getPullRequest(token, lookupOwner, lookupRepo, number) : null),
        changedFiles: async (lookupOwner, lookupRepo, which) => (api.listChangedFiles ? api.listChangedFiles(token, lookupOwner, lookupRepo, which) : null),
        issue: async (lookupOwner, lookupRepo, number) => (api.getIssue ? api.getIssue(token, lookupOwner, lookupRepo, number) : null),
      };
    } catch (err) {
      // A misconfigured/unreachable GitHub MCP server (e.g. Docker isn't
      // running) shouldn't take the whole chat down -- surface it in the
      // server's own logs and proceed without GitHub tools this turn, the
      // same as if the integration weren't connected at all.
      console.error(`[actions] workspace ${workspaceId}: GitHub MCP tools unavailable:`, errMessage(err));
    }
  };

  for (const integration of integrations) {
    if (integration.type === "github") {
      const credential = await db.getIntegrationCredential(workspaceId, "github", integration.id);
      if (credential?.token) {
        let login = integration.accountLogin ?? null;
        if (!login && integration.id) {
          login = await api.getLogin(credential.token);
          if (login) await db.setIntegrationAccountLogin(integration.id, login).catch(() => undefined);
        }
        if (credential.owner && credential.repo) await loadGithub(credential.token, login, credential.owner, credential.repo);
        else githubNotice = `${actingUser?.displayName ?? "The person asking"} connected GitHub but hasn't chosen a repository yet. They can choose one under Integrations → GitHub.`;
      }
    } else if (integration.type === "slack") {
      const credential = await db.getIntegrationCredential(workspaceId, "slack", integration.id);
      if (credential?.token) {
        try {
          const slackTools = await deps.slackMcpToolsFactory({ workspaceId, accessToken: credential.token });
          tools.push(...slackTools);
          slackAgentTools.push(...slackTools);
          accounts.slack = { via: "user", userId: requestingUserId ?? null, account: integration.teamName ?? null };
          const lookup = deps.slackChannelLookup;
          const slackToken = credential.token;
          if (lookup) slackChannelName = (channelId) => lookup(slackToken, channelId).catch(() => null);
          const finder = deps.slackChannelFinder;
          if (finder) findSlackChannels = (names) => finder(slackToken, names).catch(() => ({}));
        } catch (err) {
          // Same fail-open-without-Slack-tools policy as the GitHub MCP
          // branch above: an unreachable Slack MCP server (a revoked/
          // expired token, slack.com briefly down) shouldn't take the
          // whole chat down.
          console.error(`[actions] workspace ${workspaceId}: Slack MCP tools unavailable:`, errMessage(err));
        }
      }
    } else if (integration.type === "notion") {
      const credential = await db.getIntegrationCredential(workspaceId, "notion", integration.id);
      if (credential?.token) {
        const notionTools = buildNotionTools(credential.token);
        tools.push(...notionTools);
        remoteAgentTools.notion.push(...notionTools);
        accounts.notion = { via: "user", userId: requestingUserId ?? null, account: integration.accountName ?? null };
      }
    } else if (integration.type === "figma") {
      // Figma's REST API accepts personal access tokens and OAuth tokens;
      // its hosted MCP server rejects personal tokens. See figma-tools.ts.
      const credential = await db.getIntegrationCredential(workspaceId, "figma", integration.id);
      if (credential?.token) {
        // The chosen Figma team is stored as "<id>" or "<id>:<name>"; see db's setFigmaTeam.
        const figmaTools = buildFigmaTools(credential.token, fetch, credential.repo?.split(":")[0] || undefined);
        tools.push(...figmaTools);
        remoteAgentTools.figma.push(...figmaTools);
        accounts.figma = { via: "user", userId: requestingUserId ?? null, account: integration.accountName ?? null };
      }
    } else {
      const credential = await db.getIntegrationCredential(workspaceId, integration.type, integration.id);
      if (credential?.token && integration.endpoint) {
        try {
          const client = await getRemoteMcpClient(workspaceId, integration.type, integration.endpoint, credential.token);
          const providerTools = await listMcpToolExecutors(client, integration.type[0].toUpperCase() + integration.type.slice(1));
          tools.push(...providerTools);
          remoteAgentTools[integration.type].push(...providerTools);
          accounts[integration.type] = { via: "user", userId: requestingUserId ?? null, account: integration.accountName ?? null };
        } catch (err) {
          console.error(`[actions] workspace ${workspaceId}: ${integration.type} MCP tools unavailable:`, errMessage(err));
        }
      }
    }
  }

  return { tools, githubTools: githubAgentTools, slackTools: slackAgentTools, linearTools: remoteAgentTools.linear, notionTools: remoteAgentTools.notion, figmaTools: remoteAgentTools.figma, githubContext, githubNotice, accounts, listOpenIssues, githubLookups, slackChannelName, findSlackChannels };
}

export const PROVIDER_LABELS: Record<IntegrationType, string> = { github: "GitHub", slack: "Slack", linear: "Linear", notion: "Notion", figma: "Figma" };

/** How a provider account is shown, e.g. "@octocat" for GitHub. */
export function formatAccount(provider: IntegrationType, account: string | null | undefined): string | null {
  if (!account) return null;
  return provider === "github" ? `@${account.replace(/^@/, "")}` : account;
}

// Swaps every mutating tool's `execute` for one that queues a
// PendingAction and broadcasts it to the room, instead of touching GitHub
// for real. The agent loop (services/chat-server/src/agent.ts) never
// knows the difference -- it just sees a tool result telling it the
// action is awaiting confirmation. The REAL call only happens from the
// /actions/:id/confirm route below, which looks the same tool back up by
// name (via a fresh, unwrapped buildToolsForWorkspace call) and invokes
// its original execute. Read-only tools pass through untouched.
export function wrapForProposal(
  tools: ToolExecutor[],
  workspaceId: string,
  conversationId: string,
  rooms: RoomRegistry,
  // Whoever's chat message triggered this agent turn -- recorded on the
  // pending action itself (see sql/migrations/0001_baseline.sql) and on the "action.proposed"
  // audit event below, so the trail answers "who asked for what", not
  // just "what did the agent do". Optional: some call sites (tests that
  // build tools directly) don't have a requesting user to attribute.
  requestedBy?: { userId: string; name: string },
  agentKind?: ActionAgentKind,
  options?: {
    readOnly?: boolean;
    // The account the proposal will run as when approved (defaults to the requester).
    runAs?: ProviderAccount;
    // Open issues for the duplicate check on new GitHub issues.
    listOpenIssues?: WorkspaceTools["listOpenIssues"];
    // False for workflow runs marked "Requires approval": an auto-approve
    // rule then gives a normal approval card instead. Block and
    // require-approvals rules still apply.
    allowAutoApprove?: boolean;
    // Lookups that make approval rules more precise (see enrichTarget).
    githubLookups?: GithubLookups;
    slackChannelName?: WorkspaceTools["slackChannelName"];
    // Why the agent is proposing this: the request and its recent reads
    // (see recordReads), captured at the moment of the proposal.
    proposalContext?: () => ProposalContext | null;
  }
): ToolExecutor[] {
  // An automation review must never be able to turn an unexpected model
  // tool call into a pending external change. Remove mutating tools from its
  // visible surface entirely; returning them unwrapped would execute a write.
  const visibleTools = options?.readOnly ? tools.filter((tool) => !tool.mutates) : tools;
  return visibleTools.map((tool) => {
    if (!tool.mutates) return tool;
    return {
      ...tool,
      execute: async (args: Record<string, unknown>) => {
        // Refuse before anything is queued, so no one is asked to approve a
        // change that can't be made (e.g. outside the member's repository).
        tool.validate?.(args);
        const toolName = tool.definition.function.name;
        const description = tool.describe ? tool.describe(args) : `Run ${toolName}`;
        const preview = tool.preview ? tool.preview(args) : undefined;
        const target = await enrichTarget(toolName, args, describeActionTarget(toolName, args, agentKind), options);
        // Exactly what will change, and why it was proposed, for the card.
        const changePreview = await buildChangePreview(toolName, args, target, options?.githubLookups);
        const proposalContext = options?.proposalContext?.() ?? null;
        // Approval rules decide first: a blocked action is never queued, and
        // an auto-approved one runs now. Loading the rules is not wrapped in
        // a catch on purpose -- if they can't be read, the proposal fails
        // rather than skipping a rule that might block it.
        const decision = evaluateApprovalRules(await db.listApprovalRules(workspaceId), actionFacts(toolName, args, target), { allowAutoApprove: options?.allowAutoApprove !== false });
        const roomId = `${workspaceId}:${conversationId}`;
        if (decision.effect === "block") {
          const message = await db.insertMessage({ workspaceId, conversationId, role: "system", authorName: "System", content: `Blocked by approval rule “${decision.ruleName}”: ${description}` });
          rooms.broadcast(roomId, { type: "message", message });
          await db.recordAuditEvent({
            workspaceId,
            eventType: "action.blocked",
            actorType: "system",
            actorName: "Approval rules",
            summary: `Approval rule “${decision.ruleName}” blocked: ${description}${requestedBy?.name ? ` (requested by ${requestedBy.name})` : ""}`,
            metadata: { toolName, ruleId: decision.ruleId, ruleName: decision.ruleName, requestedByUserId: requestedBy?.userId ?? null, requestedByName: requestedBy?.name ?? null, target: target.label, repo: target.repo ?? null },
          });
          return {
            status: "blocked_by_rule",
            rule: decision.ruleName,
            description,
            note: `This action was NOT run and cannot be approved: the workspace approval rule “${decision.ruleName}” blocks it. Tell the user which rule blocked it and that an Admin can change approval rules on the Approvals page. Do not retry this action or try to reach the same result another way.`,
          };
        }
        // Duplicate and conflict checks never block a proposal; they only
        // inform the people deciding on it.
        const existing = await db.listActionsForConflictCheck(workspaceId).catch(() => []);
        let openIssues: Array<{ number: number; title: string; url: string }> = [];
        if (target.provider === "github" && target.kind === "new_issue" && target.repo && options?.listOpenIssues) {
          const [owner, repo] = target.repo.split("/");
          openIssues = await options.listOpenIssues(owner, repo).catch(() => []);
        }
        const warnings = findActionWarnings({ target, toolName, requestedByUserId: requestedBy?.userId, existing, openIssues });
        const runAs = options?.runAs;
        const autoApproveAllowed = options?.allowAutoApprove !== false;
        if (decision.effect === "auto_approve") {
          return runAutoApproved({ tool, args, workspaceId, conversationId, rooms, requestedBy, agentKind, runAs, toolName, description, preview, target, warnings, changePreview, proposalContext, source: { kind: "rule", ruleId: decision.ruleId!, ruleName: decision.ruleName! } });
        }
        // A standing approval applies only where no rule asks for more than
        // a normal approval card, and never to a "Requires approval" workflow.
        if (decision.effect === "default" && autoApproveAllowed) {
          const standing = await db.findStandingApproval(workspaceId, target.provider, toolName, standingScope(target).scope);
          if (standing) return runAutoApproved({ tool, args, workspaceId, conversationId, rooms, requestedBy, agentKind, runAs, toolName, description, preview, target, warnings, changePreview, proposalContext, source: { kind: "standing", approval: standing } });
        }
        const ruleNeedsApprovals = decision.effect === "require_approvals";
        const action = await db.createPendingAction({
          workspaceId,
          conversationId,
          toolName,
          description,
          preview,
          args,
          requestedByUserId: requestedBy?.userId,
          requestedByName: requestedBy?.name,
          agentKind: agentKind ?? null,
          runAsUserId: runAs ? runAs.userId : requestedBy?.userId ?? null,
          runAsAccount: runAs?.account ?? null,
          target,
          warnings,
          requiredApprovals: decision.requiredApprovals,
          approvalRuleId: decision.ruleId,
          approvalRuleName: decision.ruleName,
          autoApproveAllowed,
          changePreview,
          proposalContext,
        });
        rooms.broadcast(roomId, { type: "pending_action", action: { ...action, runAsAvailable: true } });
        await db.notifyWorkspaceMembers({
          workspaceId,
          conversationId,
          kind: "decision_needed",
          text: `Decision needed: ${description}${ruleNeedsApprovals ? ` (needs ${approvalsPhrase(decision.requiredApprovals)} under rule “${decision.ruleName}”)` : ""}${warnings.length ? ` (${warnings.length} possible duplicate${warnings.length === 1 ? "" : "s"})` : ""}`,
          priority: "high",
          resourceType: "action",
          resourceId: action.id,
        });
        await db.recordAuditEvent({
          workspaceId,
          eventType: "action.proposed",
          actorType: "agent",
          actorName: "Agent",
          summary: `Agent prepared an action for review${requestedBy?.name ? ` (requested by ${requestedBy.name})` : ""}: ${description}`,
          metadata: { actionId: action.id, toolName: action.toolName, requestedByUserId: requestedBy?.userId ?? null, requestedByName: requestedBy?.name ?? null, target: target.label, repo: target.repo ?? null, warnings: warnings.length, requiredApprovals: decision.requiredApprovals, ruleId: decision.ruleId, ruleName: decision.ruleName },
        });
        return {
          status: "awaiting_user_confirmation",
          actionId: action.id,
          description,
          ...(warnings.length ? { possibleDuplicates: warnings.map((warning) => warning.message) } : {}),
          ...(ruleNeedsApprovals ? { requiredApprovals: decision.requiredApprovals, rule: decision.ruleName } : {}),
          ...(describeBranchProtection(target) ? { github: describeBranchProtection(target) } : {}),
          note: `This has NOT happened yet. ${ruleNeedsApprovals ? `The workspace approval rule “${decision.ruleName}” requires ${approvalsPhrase(decision.requiredApprovals)} from people other than the requester, given on the card now shown in the UI, before it runs.` : "A human in the chat must confirm it from the card now shown in the UI before it runs."} Do not tell the user it's done -- tell them what you're proposing and that it needs their confirmation.${warnings.length ? " Mention the possible duplicates listed above in one short sentence so the team can decide." : ""}${target.branchProtection?.protected && target.kind === "file" ? ` ${target.branchProtection.branch} is a protected branch on GitHub, so a direct change there may be rejected even after approval; suggest opening a pull request instead.` : ""}`,
        };
      },
    };
  });
}

/**
 * Adds what approval rules and approvers need that the tool arguments don't
 * say: the branch a GitHub action lands on (a merge's base branch, or the
 * repository's default branch), what GitHub's own branch protection
 * requires there, and a Slack channel's name. Every lookup is best effort:
 * when one fails the value stays unknown, and restrictive rules still apply.
 */
async function enrichTarget(
  toolName: string,
  args: Record<string, unknown>,
  target: ActionTarget,
  options?: { githubLookups?: GithubLookups; slackChannelName?: WorkspaceTools["slackChannelName"] }
): Promise<ActionTarget> {
  const enriched: ActionTarget = { ...target };
  const named = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const lookups = options?.githubLookups;
  if (target.provider === "github" && target.repo && lookups) {
    const [owner, repo] = target.repo.split("/");
    if ((target.kind === "merge" || target.kind === "pull_request_update") && target.number) {
      enriched.baseBranch = (await lookups.pullRequestBase(owner, repo, target.number).catch(() => null)) ?? undefined;
    } else if ((target.kind === "file" && !named(args.branch)) || (toolName === "create_pull_request" && !named(args.base))) {
      enriched.baseBranch = (await lookups.defaultBranch(owner, repo).catch(() => null)) ?? undefined;
    }
    const facts = actionFacts(toolName, args, enriched);
    if (facts.branch && ["merge", "file_change", "create", "update"].includes(facts.category) && target.kind !== "new_issue") {
      const protection = await lookups.branchProtection(owner, repo, facts.branch).catch(() => null);
      if (protection) enriched.branchProtection = { branch: facts.branch, ...protection };
    }
  }
  if (target.provider === "slack" && options?.slackChannelName && target.channel) {
    const channel = target.channel.replace(/^#/, "");
    if (isSlackId(channel)) {
      enriched.channelName = (await options.slackChannelName(channel).catch(() => null)) ?? undefined;
      // Show "#bugs" on the card rather than the raw ID.
      if (enriched.channelName) enriched.label = `#${enriched.channelName}`;
    }
  }
  return enriched;
}

/** What GitHub itself will require, in one sentence, or null when it requires nothing known. */
export function describeBranchProtection(target: ActionTarget | null | undefined): string | null {
  const protection = target?.branchProtection;
  if (!protection?.protected) return null;
  const reviews = protection.requiredReviews;
  return `GitHub protects ${protection.branch}${reviews ? ` and requires ${reviews} approving review${reviews === 1 ? "" : "s"} on pull requests into it` : ""}.`;
}

/** "1 approval", "2 approvals". */
function approvalsPhrase(count: number): string {
  return `${count} approval${count === 1 ? "" : "s"}`;
}

/** One line for team awareness: whose agent changed what, and who approved it. */
function activityLine(action: PendingAction, requester: string, approvedBy: string | null): string {
  if (!action.target) return `${approvedBy ?? requester} confirmed: ${action.description}`;
  const change = action.target.kind === "comment" ? `comment on ${action.target.label}` : action.target.kind.startsWith("new_") ? action.target.label : `change to ${action.target.label}`;
  return `${requester}'s agent made a ${change}${approvedBy && approvedBy !== requester ? ` (approved by ${approvedBy})` : ""}`;
}

/** What approved an action without a person deciding on it. */
type AutoApprovalSource = { kind: "rule"; ruleId: string; ruleName: string } | { kind: "standing"; approval: StandingApproval };

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** e.g. 'rule “Comments are fine”' or "Marcus's standing approval (add issue comment on acme/web, until Oct 31)". */
function autoApprovalPhrase(source: AutoApprovalSource): string {
  return source.kind === "rule" ? `rule “${source.ruleName}”` : `${source.approval.createdByName}'s standing approval (${source.approval.description}, until ${shortDate(source.approval.expiresAt)})`;
}

// Runs an action that an auto-approve rule or a standing approval allows,
// right away, as the requester. It is still recorded as an action (already
// confirmed), so the audit trail, the team activity feed and the agent's own
// history all show it.
async function runAutoApproved(input: {
  tool: ToolExecutor;
  args: Record<string, unknown>;
  workspaceId: string;
  conversationId: string;
  rooms: RoomRegistry;
  requestedBy?: { userId: string; name: string };
  agentKind?: ActionAgentKind;
  runAs?: ProviderAccount;
  toolName: string;
  description: string;
  preview?: string;
  target: ActionTarget;
  warnings: ReturnType<typeof findActionWarnings>;
  changePreview?: ChangePreview | null;
  proposalContext?: ProposalContext | null;
  source: AutoApprovalSource;
}): Promise<unknown> {
  const { workspaceId, conversationId, rooms, requestedBy, description, source } = input;
  const by = autoApprovalPhrase(source);
  const sourceMetadata = source.kind === "rule" ? { ruleId: source.ruleId, ruleName: source.ruleName } : { standingApprovalId: source.approval.id, standingApprovalBy: source.approval.createdByName };
  const roomId = `${workspaceId}:${conversationId}`;
  const provider = input.target.provider;
  const runUserId = input.runAs ? input.runAs.userId : requestedBy?.userId ?? null;
  const action = await db.createPendingAction({
    workspaceId,
    conversationId,
    toolName: input.toolName,
    description,
    preview: input.preview,
    args: input.args,
    requestedByUserId: requestedBy?.userId,
    requestedByName: requestedBy?.name,
    agentKind: input.agentKind ?? null,
    runAsUserId: runUserId,
    runAsAccount: input.runAs?.account ?? null,
    target: input.target,
    warnings: input.warnings,
    requiredApprovals: 0,
    approvalRuleId: source.kind === "rule" ? source.ruleId : null,
    approvalRuleName: source.kind === "rule" ? source.ruleName : `Standing approval from ${source.approval.createdByName}`,
    autoApproved: true,
    changePreview: input.changePreview ?? null,
    proposalContext: input.proposalContext ?? null,
  });
  const account = formatAccount(provider, input.runAs?.account);
  const asName = requestedBy?.name ?? "the requester";
  const watchers = () => rooms.participants(roomId).flatMap((participant) => (participant.userId ? [participant.userId] : []));
  try {
    const result = await input.tool.execute(input.args);
    const resultText = typeof result === "string" ? result : JSON.stringify(result);
    await db.setActionExecutedAs(workspaceId, action.id, runUserId, input.runAs?.account ?? null);
    await db.resolvePendingAction({ workspaceId, id: action.id, status: "confirmed", result: resultText });
    const message = await db.insertMessage({
      workspaceId,
      conversationId,
      role: "system",
      authorName: "System",
      content: `Auto-approved by ${by}: ${description}. Ran as ${asName}${account ? ` (${account})` : ""}.`,
    });
    rooms.broadcast(roomId, { type: "message", message });
    await db.notifyWorkspaceMembers({ workspaceId, conversationId, kind: "action_completed", text: `Auto-approved by ${by} and completed: ${description}`, excludeUserIds: watchers() });
    const activity = `${activityLine(action, asName, null)} (auto-approved by ${source.kind === "rule" ? by : `${source.approval.createdByName}'s standing approval`})`;
    const url = resultUrl(resultText);
    const event = await db.recordAuditEvent({
      workspaceId,
      eventType: "action.auto_approved",
      actorType: "system",
      actorName: "Approval rules",
      summary: `Auto-approved by ${by}: ${description}${requestedBy?.name ? ` (requested by ${requestedBy.name})` : ""}`,
      metadata: { actionId: action.id, toolName: input.toolName, provider, ...sourceMetadata, target: input.target.label, repo: input.target.repo ?? null, executedAs: account ?? asName, activity, url },
    });
    const teamActivity: TeamActivity = { id: event.id, source: "nexus", actorName: asName, summary: activity, repo: input.target.repo ?? null, url, createdAt: event.createdAt };
    rooms.broadcast(workspaceId, { type: "team_activity", activity: teamActivity });
    return {
      status: "completed",
      autoApproved: true,
      approvedBy: by,
      result,
      note: `This action was auto-approved by ${by} and has already run. Tell the user it's done and what approved it.`,
    };
  } catch (err) {
    const failureReason = errMessage(err);
    console.error(`[actions] workspace ${workspaceId}: auto-approved action ${action.id} (${input.toolName}) failed:`, failureReason);
    captureError(err, { where: "action-auto-approve", workspaceId, actionId: action.id, toolName: input.toolName });
    await db.resolvePendingAction({ workspaceId, id: action.id, status: "failed", result: failureReason });
    const message = await db.insertMessage({ workspaceId, conversationId, role: "system", authorName: "System", content: `Auto-approved by ${by}, but it failed: ${description}. ${failureReason}` });
    rooms.broadcast(roomId, { type: "message", message });
    await db.recordAuditEvent({
      workspaceId,
      eventType: "action.failed",
      actorType: "system",
      actorName: "Approval rules",
      summary: `Auto-approved by ${by}, but “${description}” failed: ${failureReason}`,
      metadata: { actionId: action.id, toolName: input.toolName, ...sourceMetadata, failureReason },
    });
    return { status: "failed", autoApproved: true, approvedBy: by, error: failureReason, note: "This action was auto-approved, but running it failed. Tell the user it did not happen and why." };
  }
}

const MAX_READS_KEPT = 6;
const READ_EXCERPT = 1_500;

/**
 * Wraps the agent's read tools so each call is noted in `reads`: which tool,
 * with what, and the start of what it returned. Proposals take the last few
 * as their "why" (ProposalContext), so an approver can see when an action
 * came from text the agent read -- an issue, a message -- rather than from a
 * person. Write tools pass through untouched.
 */
export function recordReads(tools: ToolExecutor[], reads: ProposalContext["reads"]): ToolExecutor[] {
  return tools.map((tool) => {
    if (tool.mutates) return tool;
    return {
      ...tool,
      execute: async (args: Record<string, unknown>) => {
        const result = await tool.execute(args);
        const resultText = typeof result === "string" ? result : JSON.stringify(result) ?? "";
        const summary = Object.entries(args)
          .filter(([, value]) => value !== undefined && value !== null && value !== "" && typeof value !== "object")
          .map(([key, value]) => `${key}: ${String(value).slice(0, 80)}`)
          .join(", ");
        reads.push({ tool: tool.definition.function.name, summary, excerpt: resultText.length > READ_EXCERPT ? `${resultText.slice(0, READ_EXCERPT)}…` : resultText });
        if (reads.length > MAX_READS_KEPT) reads.splice(0, reads.length - MAX_READS_KEPT);
        return result;
      },
    };
  });
}

/** The request, as stored with a proposal: the full text, capped visibly. */
export function proposalRequest(text: string | null | undefined): string | null {
  return text ? fullText(text) : null;
}

/** How long a standing approval from an approval card lasts. */
export const STANDING_APPROVAL_DAYS = 7;

/** Tells the room, the activity log and the people waiting that an action expired. */
async function announceExpired(rooms: RoomRegistry, action: PendingAction): Promise<void> {
  const roomId = `${action.workspaceId}:${action.conversationId}`;
  rooms.broadcast(roomId, { type: "pending_action_update", action });
  const message = await db.insertMessage({
    workspaceId: action.workspaceId,
    conversationId: action.conversationId,
    role: "system",
    authorName: "System",
    content: `Expired without approval: ${action.description}. Nothing was changed. Ask the agent again if it's still needed.`,
  });
  rooms.broadcast(roomId, { type: "message", message });
  await db.recordAuditEvent({
    workspaceId: action.workspaceId,
    eventType: "action.expired",
    actorType: "system",
    actorName: "Approval rules",
    summary: `Expired after ${db.actionApprovalTtlHours()} hours without approval: ${action.description}`,
    metadata: { actionId: action.id, toolName: action.toolName, approvals: action.approvals?.length ?? 0, requiredApprovals: action.requiredApprovals ?? 1 },
  });
}

/** Cancels actions that waited past the approval window. Run on a timer by the server. */
export async function expireStaleActions(rooms: RoomRegistry): Promise<number> {
  const expired = await db.expireStalePendingActions();
  for (const action of expired) await announceExpired(rooms, action);
  return expired.length;
}

/** Records "approve similar actions for 7 days" after an approver confirmed one. */
async function grantStandingApproval(workspaceId: string, action: PendingAction, approver: { userId: string; name: string }, rooms: RoomRegistry): Promise<StandingApproval | null> {
  const target = action.target ?? describeActionTarget(action.toolName, action.args, action.agentKind);
  const { scope, label } = standingScope(target);
  const description = `${action.toolName.replace(/[_-]+/g, " ")} on ${label}`;
  const approval = await db.createStandingApproval({ workspaceId, provider: target.provider, toolName: action.toolName, scope, scopeLabel: label, description, createdBy: approver, sourceActionId: action.id, days: STANDING_APPROVAL_DAYS });
  const message = await db.insertMessage({
    workspaceId,
    conversationId: action.conversationId,
    role: "system",
    authorName: "System",
    content: `${approver.name} also approved similar actions (${description}) until ${shortDate(approval.expiresAt)}. Any Admin can revoke this on the Approvals page.`,
  });
  rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "message", message });
  await db.recordAuditEvent({
    workspaceId,
    eventType: "standing_approval.created",
    actorType: "user",
    actorUserId: approver.userId,
    actorName: approver.name,
    summary: `${approver.name} approved similar actions (${description}) for ${STANDING_APPROVAL_DAYS} days`,
    metadata: { standingApprovalId: approval.id, sourceActionId: action.id, toolName: action.toolName, scope, expiresAt: approval.expiresAt },
  });
  return approval;
}

/** Adds runAsAvailable: whether the member the action runs as still has a usable connection. */
export async function withRunAsAvailability(workspaceId: string, deps: CreateServerDeps, actions: PendingAction[]): Promise<PendingAction[]> {
  if (!actions.some((action) => action.status === "pending")) return actions;
  const integrations = await db.listIntegrations(workspaceId);
  const roles = new Map((await db.listWorkspaceMembersWithRoles(workspaceId)).map((member) => [member.id, member.role] as const));
  const policy = await db.getWorkspacePermissionPolicy(workspaceId);
  return actions.map((action) => {
    if (action.status !== "pending") return action;
    const provider = providerForTool(action.toolName, action.agentKind);
    const userId = action.runAsUserId ?? action.requestedByUserId;
    if (!userId) return { ...action, runAsAvailable: true };
    const connected = integrations.some((integration) => integration.type === provider && integration.ownerUserId === userId);
    // Their role must still allow the tool (Admins hold every permission).
    const role = roles.get(userId);
    const permitted = role === "admin" || (role === "editor" && policy.editor[provider]);
    return { ...action, runAsAvailable: connected && permitted };
  });
}

/** A link to what a confirmed action created or changed, when the provider returned one. */
function resultUrl(resultText: string): string | null {
  return resultText.match(/https:\/\/github\.com\/[^"\s\\]+/)?.[0] ?? null;
}

export function registerActionRoutes(app: Express, deps: CreateServerDeps, rooms: RoomRegistry): void {
  app.get("/workspaces/:id/actions", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    if (!UUID_RE.test(conversationId)) return res.status(400).json({ error: "valid conversationId is required" });
    if (!(await db.getWorkspaceRole(workspaceId, req.user!.id))) return res.status(403).json({ error: "You do not have permission to perform this action." });
    const onlyPending = req.query.status !== "all";
    res.json(await withRunAsAvailability(workspaceId, deps, await db.listPendingActions(workspaceId, conversationId, onlyPending)));
  });

  // Passing failures to next() (instead of `void`) sends them to the error
  // handler; an unhandled rejection here would terminate the server.
  app.post("/workspaces/:id/actions/:actionId/confirm", (req: Request, res: Response, next: NextFunction) => {
    resolveAction(req, res, "confirmed").catch(next);
  });

  app.post("/workspaces/:id/actions/:actionId/cancel", (req: Request, res: Response, next: NextFunction) => {
    resolveAction(req, res, "cancelled").catch(next);
  });

  async function resolveAction(req: Request, res: Response, intent: "confirmed" | "cancelled"): Promise<void> {
    const workspaceId = paramString(req.params.id);
    const actionId = paramString(req.params.actionId);
    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(actionId)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    // Two approvals arriving together (two Admins, a double-click, a retry)
    // used to both pass the "still pending" check below and run the write
    // twice -- two issues, two Slack posts. Only one request at a time may
    // resolve a given action, across every server process; the status is
    // re-read once the lock is held, so the second request sees the result.
    const outcome = await db.tryWithAdvisoryLock(`pending-action:${actionId}`, () => resolveActionLocked(req, res, intent, workspaceId, actionId));
    if (!outcome.acquired) {
      res.status(409).json({ error: "Someone is already confirming or cancelling this action." });
    }
  }

  async function resolveActionLocked(req: Request, res: Response, intent: "confirmed" | "cancelled", workspaceId: string, actionId: string): Promise<void> {
    const action = await db.getPendingAction(workspaceId, actionId);
    if (!action) {
      res.status(404).json({ error: "action not found" });
      return;
    }
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role || !(await db.hasWorkspacePermission(workspaceId, role, "approveActions"))) {
      res.status(403).json({ error: "Your workspace role does not have permission to approve or cancel write actions." });
      return;
    }
    if (action.status !== "pending") {
      res.status(409).json({ error: `action is already ${action.status}` });
      return;
    }
    const actorName = req.user!.displayName;
    const roomId = `${workspaceId}:${action.conversationId}`;
    const watchers = () => [req.user!.id, ...rooms.participants(roomId).flatMap((participant) => (participant.userId ? [participant.userId] : []))];

    // Approvals expire: an action nobody approved within the window is
    // cancelled rather than run long after the conversation moved on.
    if (intent === "confirmed" && action.expiresAt && Date.parse(action.expiresAt) <= Date.now()) {
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "cancelled", result: `Expired: nobody approved it within ${db.actionApprovalTtlHours()} hours.` });
      if (resolved) await announceExpired(rooms, resolved);
      res.status(409).json({ error: `This action expired after ${db.actionApprovalTtlHours()} hours without approval, so it was cancelled. Ask the agent again if it's still needed.`, code: "expired" });
      return;
    }
    // Approval rules, checked again now: a rule added or tightened after the
    // action was proposed still applies to it. The stricter of the decision
    // made at proposal time and the current one wins. Auto-approve never
    // applies here -- someone is already deciding.
    let requiredApprovals = Math.max(1, action.requiredApprovals ?? 1);
    let ruleName = action.approvalRuleName ?? null;
    let ruleGoverned = Boolean(action.approvalRuleId);
    if (intent === "confirmed") {
      const target = action.target ?? describeActionTarget(action.toolName, action.args, action.agentKind);
      const current = evaluateApprovalRules(await db.listApprovalRules(workspaceId), actionFacts(action.toolName, action.args, target), { allowAutoApprove: false });
      if (current.effect === "block") {
        const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "cancelled", result: `Blocked by approval rule “${current.ruleName}”.` });
        rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
        const message = await db.insertMessage({ workspaceId, conversationId: action.conversationId, role: "system", authorName: "System", content: `Blocked by approval rule “${current.ruleName}”: ${action.description}. ${actorName}'s approval was not used.` });
        rooms.broadcast(roomId, { type: "message", message });
        await db.recordAuditEvent({
          workspaceId,
          eventType: "action.blocked",
          actorType: "user",
          actorUserId: req.user!.id,
          actorName,
          summary: `Approval rule “${current.ruleName}” blocked “${action.description}” when ${actorName} tried to confirm it`,
          metadata: { actionId, toolName: action.toolName, ruleId: current.ruleId, ruleName: current.ruleName },
        });
        res.status(409).json({ error: `The approval rule “${current.ruleName}” blocks this action, so it was cancelled.`, code: "blocked_by_rule" });
        return;
      }
      if (current.effect === "require_approvals") {
        ruleGoverned = true;
        if (current.requiredApprovals >= requiredApprovals) {
          requiredApprovals = current.requiredApprovals;
          ruleName = current.ruleName;
        }
      }
    }
    const approvals = action.approvals ?? [];
    // "Also approve similar actions for 7 days" from the card.
    const remember = intent === "confirmed" && req.body?.remember === true;
    if (remember && (ruleGoverned || action.autoApproveAllowed === false)) {
      res.status(400).json({ error: "Standing approvals aren't available for actions an approval rule governs, or for workflows that require approval.", code: "standing_not_allowed" });
      return;
    }
    if (intent === "confirmed" && ruleGoverned) {
      // Under a rule, approvals must come from people other than the requester.
      if (action.requestedByUserId && action.requestedByUserId === req.user!.id) {
        res.status(403).json({ error: `The approval rule “${ruleName}” needs ${approvalsPhrase(requiredApprovals)} from people other than the person who asked for this action.`, code: "requester_cannot_approve" });
        return;
      }
      if (approvals.some((approval) => approval.userId === req.user!.id)) {
        const left = requiredApprovals - approvals.length;
        res.status(409).json({ error: `You already approved this. It needs ${approvalsPhrase(Math.max(left, 1))} more from someone else.`, code: "already_approved" });
        return;
      }
      if (approvals.length + 1 < requiredApprovals) {
        await db.recordActionApproval(actionId, { userId: req.user!.id, name: actorName });
        const updated = await db.getPendingAction(workspaceId, actionId);
        const [withAvailability] = await withRunAsAvailability(workspaceId, deps, updated ? [updated] : []);
        rooms.broadcast(roomId, { type: "pending_action_update", action: withAvailability });
        const count = approvals.length + 1;
        const message = await db.insertMessage({
          workspaceId,
          conversationId: action.conversationId,
          role: "system",
          authorName: "System",
          content: `${actorName} approved (${count} of ${requiredApprovals} under rule “${ruleName}”): ${action.description}. Waiting for ${approvalsPhrase(requiredApprovals - count)} more.`,
        });
        rooms.broadcast(roomId, { type: "message", message });
        await db.notifyWorkspaceMembers({
          workspaceId,
          conversationId: action.conversationId,
          kind: "decision_needed",
          text: `${actorName} approved ${count} of ${requiredApprovals}: ${action.description}. ${approvalsPhrase(requiredApprovals - count)} still needed.`,
          priority: "high",
          resourceType: "action",
          resourceId: actionId,
          excludeUserIds: [req.user!.id, ...(action.requestedByUserId ? [action.requestedByUserId] : [])],
        });
        await db.recordAuditEvent({
          workspaceId,
          eventType: "action.approved",
          actorType: "user",
          actorUserId: req.user!.id,
          actorName,
          summary: `${actorName} approved ${count} of ${requiredApprovals}: ${action.description}`,
          metadata: { actionId, toolName: action.toolName, ruleName, approvals: count, requiredApprovals },
        });
        res.json(withAvailability);
        return;
      }
    }

    if (intent === "cancelled") {
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "cancelled" });
      rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
      const message = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} cancelled: ${action.description}`,
      });
      rooms.broadcast(roomId, { type: "message", message });
      await db.notifyWorkspaceMembers({
        workspaceId,
        conversationId: action.conversationId,
        kind: "action_completed",
        text: `${actorName} cancelled: ${action.description}`,
        excludeUserIds: watchers(),
      });
      await db.recordAuditEvent({
        workspaceId,
        eventType: "action.cancelled",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} cancelled: ${action.description}`,
        metadata: { actionId, toolName: action.toolName },
      });
      res.json(resolved);
      return;
    }

    // Run-as rule: an approved action runs with the requester's own
    // connection. When that is no longer usable, the approver may choose to
    // run it as themselves.
    const provider = providerForTool(action.toolName, action.agentKind);
    const runAsMe = req.body?.runAs === "me";
    const runUserId = runAsMe ? req.user!.id : action.runAsUserId ?? action.requestedByUserId ?? req.user!.id;
    // The policy and the person must both allow it: whoever the action runs
    // as must still be a member whose role may use this tool. A requester who
    // was removed or lost the tool permission can't have a write run as them.
    const mayUseTool = async (userId: string) => {
      const memberRole = await db.getWorkspaceRole(workspaceId, userId);
      return !!memberRole && (await db.hasWorkspacePermission(workspaceId, memberRole, provider));
    };
    if (runAsMe && !(await mayUseTool(req.user!.id))) {
      res.status(403).json({ error: `Your role can't use ${PROVIDER_LABELS[provider]} in this workspace, so you can't run this as yourself.`, code: "tool_not_permitted" });
      return;
    }
    const runnerAllowed = runAsMe || (await mayUseTool(runUserId));
    const runnerName = action.runAsName ?? action.requestedByName ?? "The requester";
    const built = await buildToolsForWorkspace(workspaceId, deps, runUserId);
    // A GitHub action can only run through an account that works in the
    // repository it targets and can write there. Each member works in one
    // repository, so a connection pointed at another repository, or one that
    // can only read this one, counts as unavailable.
    const repoBlocked = (tools: WorkspaceTools) => {
      if (provider !== "github" || !action.target?.repo) return false;
      const context = tools.githubContext;
      if (!context) return true;
      return `${context.owner}/${context.repo}`.toLowerCase() !== action.target.repo.toLowerCase() || context.access === "none" || context.access === "read";
    };
    const tool = !runnerAllowed || repoBlocked(built) ? undefined : built.tools.find((t) => t.definition.function.name === action.toolName);
    if (!tool) {
      // Offer "Run as me" instead of failing when the approver's own
      // connection can do it and their role may use the tool. The action
      // stays pending until they choose.
      if (!runAsMe && runUserId !== req.user!.id && (await mayUseTool(req.user!.id))) {
        const mine = await buildToolsForWorkspace(workspaceId, deps, req.user!.id);
        if (!repoBlocked(mine) && mine.tools.some((t) => t.definition.function.name === action.toolName)) {
          const why = runnerAllowed ? `${runnerName}'s ${PROVIDER_LABELS[provider]} connection can no longer run this action` : `${runnerName} can no longer use ${PROVIDER_LABELS[provider]} in this workspace`;
          res.status(409).json({
            error: `${why}. You can run it as yourself${formatAccount(provider, mine.accounts[provider]?.account) ? ` (${formatAccount(provider, mine.accounts[provider]?.account)})` : ""} instead.`,
            code: "run_as_unavailable",
            canRunAsMe: true,
          });
          return;
        }
      }
      const reason = runnerAllowed ? "the integration this action needed is no longer connected" : `${runnerName} no longer has permission to use ${PROVIDER_LABELS[provider]} in this workspace`;
      console.error(`[actions] workspace ${workspaceId}: confirm failed for action ${actionId} (${action.toolName}) -- ${reason}`);
      const resolved = await db.resolvePendingAction({
        workspaceId,
        id: actionId,
        status: "failed",
        result: `${reason[0].toUpperCase()}${reason.slice(1)}.`,
      });
      rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
      // Without this, the card just silently vanishes from the UI (it's no
      // longer "pending") and nobody -- neither the humans in the room nor
      // the agent's own next-turn history -- ever learns the confirm
      // actually failed.
      const failureMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} tried to confirm "${action.description}", but it failed: ${reason}.`,
      });
      rooms.broadcast(roomId, { type: "message", message: failureMessage });
      await db.recordAuditEvent({
        workspaceId,
        eventType: "action.failed",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} tried to confirm "${action.description}", but it failed: ${reason}`,
        metadata: { actionId, toolName: action.toolName },
      });
      res.status(409).json({ error: runnerAllowed ? "integration no longer connected" : `${reason}.`, code: runnerAllowed ? "integration_unavailable" : "tool_not_permitted" });
      return;
    }

    const executed = built.accounts[provider];
    const executedAccount = formatAccount(provider, executed?.account);
    const executedAsName = runAsMe ? actorName : action.runAsName ?? action.requestedByName ?? actorName;
    // The approval that completes the set is recorded only once the action
    // actually runs, so a "Run as me" retry isn't refused as a repeat.
    if (ruleGoverned) await db.recordActionApproval(actionId, { userId: req.user!.id, name: actorName });
    const approvedBy = ruleGoverned ? [...approvals.map((approval) => approval.name), actorName].join(" and ") : actorName;
    try {
      const result = await tool.execute(action.args);
      const resultText = typeof result === "string" ? result : JSON.stringify(result);
      await db.setActionExecutedAs(workspaceId, actionId, runUserId ?? null, executed?.account ?? null);
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "confirmed", result: resultText });
      rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
      const ranAs = runAsMe
        ? ` It ran as ${actorName}${executedAccount ? ` (${executedAccount})` : ""} because ${action.runAsName ?? action.requestedByName ?? "the requester"}'s connection was unavailable.`
        : executedAccount ? ` Ran as ${executedAsName} (${executedAccount}).` : "";
      const message = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: ruleGoverned ? `Approved by ${approvedBy} under rule “${ruleName}”: ${action.description}.${ranAs}` : `${actorName} confirmed: ${action.description}.${ranAs}`,
      });
      rooms.broadcast(roomId, { type: "message", message });
      // A click acknowledgement only proves someone approved the action;
      // it does not prove the provider call finished. Publish this separate
      // agent message only after execute() succeeds, so a later question
      // cannot leave the room with the stale "pending" wording the model
      // used before the provider completed the write.
      const completionMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "agent",
        authorName: completionAgentFor(action.agentKind, action.toolName),
        content: `The requested action has completed: ${action.description}.`,
        provenance: { provider, via: "user", actedAsUserId: runUserId ?? null, actedAsName: executedAsName, account: executed?.account ?? null, ...(action.target?.repo ? { repos: [action.target.repo] } : {}) },
      });
      rooms.broadcast(roomId, { type: "message", message: completionMessage });
      // Members who are not watching this conversation learn the write
      // actually happened (the cancel branch above sends the matching
      // "cancelled" notification).
      await db.notifyWorkspaceMembers({
        workspaceId,
        conversationId: action.conversationId,
        kind: "action_completed",
        text: `${actorName} confirmed and completed: ${action.description}`,
        excludeUserIds: watchers(),
      });
      // One line for team awareness: whose agent changed what, and where.
      const requester = action.requestedByName ?? executedAsName;
      const activity = activityLine(action, requester, approvedBy);
      const url = resultUrl(resultText);
      const event = await db.recordAuditEvent({
        workspaceId,
        eventType: "action.confirmed",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} confirmed: ${action.description}`,
        metadata: { actionId, toolName: action.toolName, provider, target: action.target?.label ?? null, repo: action.target?.repo ?? null, executedAs: executedAccount ?? executedAsName, activity, url, ...(ruleGoverned ? { ruleName, approvedBy, requiredApprovals } : {}) },
      });
      const teamActivity: TeamActivity = { id: event.id, source: "nexus", actorName, summary: activity, repo: action.target?.repo ?? null, url, createdAt: event.createdAt };
      rooms.broadcast(workspaceId, { type: "team_activity", activity: teamActivity });
      if (remember) await grantStandingApproval(workspaceId, action, { userId: req.user!.id, name: actorName }, rooms);
      res.json(resolved);
    } catch (err) {
      // A failed confirm (e.g. the GitHub MCP container not reachable, a
      // stale token, GitHub rejecting the write) resolves the action to
      // "failed", posts why in the room, and records it.
      const failureReason = errMessage(err);
      console.error(`[actions] workspace ${workspaceId}: confirm failed for action ${actionId} (${action.toolName}):`, failureReason);
      captureError(err, { where: "action-confirm", workspaceId, actionId, toolName: action.toolName });
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "failed", result: failureReason });
      rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
      const failureMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} tried to confirm "${action.description}", but it failed: ${failureReason}`,
      });
      rooms.broadcast(roomId, { type: "message", message: failureMessage });
      await db.recordAuditEvent({
        workspaceId,
        eventType: "action.failed",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} tried to confirm "${action.description}", but it failed: ${failureReason}`,
        metadata: { actionId, toolName: action.toolName, failureReason },
      });
      res.status(502).json({ error: failureReason });
    }
  }
}
