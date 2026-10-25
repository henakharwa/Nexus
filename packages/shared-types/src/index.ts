// Shared types for the Multiplayer AI chat product: a shared team workspace
// where members read GitHub/Slack through one live group chat with an LLM
// agent. Deliberately small -- this is the whole Phase 1 contract, not a
// speculative superset.

export interface Workspace {
  id: string; // uuid
  name: string;
  joinCode: string; // short, shareable code (part of the join link)
  createdAt: string; // ISO
}

export type WorkspaceRole = "admin" | "editor";

/** A workspace the signed-in user belongs to, with their role in it. */
export interface WorkspaceMembership extends Workspace {
  role: WorkspaceRole;
}

export interface WorkspaceMember extends User {
  role: WorkspaceRole;
  joinedAt: string;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  archivedAt: string | null;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceNotification {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  kind: "agent_completed" | "decision_needed" | "action_completed" | "permission_request" | "workflow_alert";
  text: string;
  priority: "low" | "normal" | "high";
  groupKey: string | null;
  resourceType: "conversation" | "workflow" | "action" | "artifact" | "integration" | null;
  resourceId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface WorkspaceNotificationPreferences {
  workspaceId: string;
  browserEnabled: boolean;
  escalationMinutes: number;
  dailySummaryEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  digestHour: number;
  updatedAt: string | null;
}

// A real account -- "Sign in with GitHub" (services/chat-server/src/auth.ts)
// is the only way to get one; there's no separate password to manage.
// Replaces the old model where anyone with a workspace's join code typed
// an arbitrary, unverified display name (see docs/spec.md's Phase 2 note:
// "real user accounts, replacing join-by-link workspaces"). githubId is
// GitHub's own numeric user id (stable even if the person renames their
// GitHub account, unlike username) -- the actual identity key; username
// and displayName are just what GitHub reported at last login.
export interface User {
  id: string; // uuid
  githubId: string | null;
  username: string; // GitHub login, e.g. "octocat"
  displayName: string; // GitHub's "name" field, falls back to username if unset
  avatarUrl: string | null;
  createdAt: string; // ISO
  // Only present for an email+password account (packages/db's
  // password_credentials table) -- undefined for a GitHub/Google login,
  // which has no password and nothing here to verify/reset.
  email?: string;
  emailVerified?: boolean;
}

export type MessageRole = "user" | "agent" | "system";

export interface ChatMessage {
  id: string; // uuid
  workspaceId: string;
  conversationId: string;
  role: MessageRole;
  authorName: string; // display name for "user" messages, "Agent" for agent replies, "System" for system
  // Immutable provenance lets clients identify the signed-in user even when names match.
  authorUserId?: string;
  content: string;
  createdAt: string; // ISO
  // @-mention / handoff mechanics (docs/spec.md Phase 2) -- computed once
  // server-side when a 'user' message is sent (see
  // services/chat-server/src/mentions.ts). mentionsAgent is true for any
  // message with no @-mention at all (the agent's default audience) or
  // one that explicitly @-mentions the agent; it's false only when the
  // message @-mentions one or more teammates and NOT the agent -- that's
  // what "hands off" the message instead of triggering an agent turn.
  // Always true/empty for 'agent'/'system' messages, which don't parse
  // mentions.
  mentionsAgent: boolean;
  mentionedUserIds: string[];
  // Which account and repositories an agent reply actually used, so a
  // shared conversation shows whose access answered each question. Set only
  // on agent replies that called a provider tool.
  provenance?: MessageProvenance | null;
}

export interface MessageProvenance {
  provider: IntegrationType;
  // Always the member's own connection. (Replies from before the workspace
  // GitHub App was removed may still say "app".)
  via: "user" | "app";
  actedAsUserId: string | null;
  actedAsName: string;
  // Provider account, e.g. a GitHub username ("octocat").
  account: string | null;
  // GitHub repositories the reply read from ("owner/repo").
  repos?: string[];
}

export type IntegrationType = "github" | "slack" | "linear" | "notion" | "figma";
export type ConnectionScope = "shared" | "personal";

export interface WorkspacePermissions {
  connectTools: boolean;
  createAgents: boolean;
  publishAgents: boolean;
  manageWorkflows: boolean;
  manageMemory: boolean;
  manageArtifacts: boolean;
  approveActions: boolean;
  github: boolean;
  slack: boolean;
  linear: boolean;
  notion: boolean;
  figma: boolean;
}

export interface WorkspacePermissionPolicy {
  admin: WorkspacePermissions;
  editor: WorkspacePermissions;
}

export interface WorkspaceAgent {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  baseAgent: "project" | IntegrationType;
  instructions: string;
  knowledge: string;
  approvedProviders: IntegrationType[];
  model: string;
  status: "draft" | "published";
  ownerUserId: string | null;
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAgentVersion {
  id: string;
  agentId: string;
  version: number;
  instructions: string;
  knowledge: string;
  approvedProviders: IntegrationType[];
  model: string;
  publishedByUserId: string | null;
  createdAt: string;
}

export type WorkflowTrigger = "manual" | "schedule" | "github_issue" | "github_status" | "slack_mention";
export type WorkflowRunStatus = "running" | "succeeded" | "failed";

export interface WorkspaceWorkflow {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  agentKind: "project" | IntegrationType;
  workspaceAgentId: string | null;
  conversationId: string | null;
  trigger: WorkflowTrigger;
  scheduleMinutes: number | null;
  enabled: boolean;
  /** Approval checkpoint: the run must stop for review before proposing an external change. */
  requiresApproval: boolean;
  ownerUserId: string | null;
  // Display name of the owner, and whether they are still a member. A
  // workflow whose owner left can't run until an Admin takes it over.
  ownerName?: string | null;
  ownerIsMember?: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: WorkflowRunStatus | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workspaceId: string;
  trigger: WorkflowTrigger;
  status: WorkflowRunStatus;
  detail: string | null;
  startedAt: string;
  completedAt: string | null;
  toolCalls: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  /** Token counts supplied in the provider's response, when available. */
  providerPromptTokens: number | null;
  providerCompletionTokens: number | null;
  /** Cost supplied in the provider's response, when available. */
  providerCostUsd: number | null;
  outputExcerpt: string | null;
  inputExcerpt: string | null;
  toolTrace: Array<{ name: string; durationMs: number; status: "succeeded" | "failed" }>;
}

export interface ObservabilityRetentionPolicy {
  workspaceId: string;
  retentionDays: 7 | 30 | 90 | 365;
  /** Failed workflow runs in 24 hours that trigger a workspace alert. */
  failureAlertThreshold: number;
  /** Server-side per-request token ceiling for agent turns (AGENT_LLM_TPM_LIMIT). */
  perTurnTokenLimit?: number;
  updatedAt: string | null;
}

export type WorkspaceTaskStatus = "todo" | "in_progress" | "review" | "done";
export interface WorkspaceTask {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: WorkspaceTaskStatus;
  ownerUserId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  sourceConversationId: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceMemoryKind = "knowledge" | "decision";

export interface WorkspaceMemory {
  id: string;
  workspaceId: string;
  kind: WorkspaceMemoryKind;
  title: string;
  content: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  freshUntil: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceArtifactType = "plan" | "report" | "release_notes" | "dashboard" | "task_list";
export type WorkspaceArtifactStatus = "draft" | "published" | "archived";
export type DashboardHealth = "on_track" | "at_risk" | "off_track";
export interface DashboardMetric { id: string; label: string; value: string; trend: "up" | "down" | "flat"; target: string; }
export interface DashboardMilestone { id: string; label: string; progress: number; }
export interface DashboardRisk { id: string; title: string; severity: "low" | "medium" | "high"; owner: string; }
export interface DashboardDecision { id: string; title: string; owner: string; dueDate: string; }
export interface DashboardChecklistItem { id: string; label: string; done: boolean; }
export interface WorkspaceArtifactDashboard { health: DashboardHealth; metrics: DashboardMetric[]; milestones: DashboardMilestone[]; risks: DashboardRisk[]; decisions: DashboardDecision[]; checklist: DashboardChecklistItem[]; }

/** A durable, shared output created by a teammate or an agent. */
export interface WorkspaceArtifact {
  id: string;
  workspaceId: string;
  type: WorkspaceArtifactType;
  status: WorkspaceArtifactStatus;
  title: string;
  summary: string;
  content: string;
  dashboardData: WorkspaceArtifactDashboard | null;
  // Non-null while a public, read-only share link is active for this
  // artifact (dashboard or release_notes) -- see server.ts's POST/DELETE
  // .../share.
  shareToken: string | null;
  // Release Notes only (null for every other type) -- a free-form tag
  // like "v1.2.0" or "Sprint 14" so one release note has a clear
  // boundary from the next.
  releaseVersion: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

// The safe subset of a dashboard artifact served, without auth, at a
// public share link (GET /public/dashboards/:token) -- no ids, owners,
// or anything else workspace-internal.
export interface PublicDashboardView {
  title: string;
  summary: string;
  workspaceName: string;
  dashboardData: WorkspaceArtifactDashboard;
  updatedAt: string;
}

// The safe subset of a Release Notes artifact served, without auth, at a
// public share link (GET /public/release-notes/:token).
export interface PublicReleaseNotesView {
  title: string;
  summary: string;
  workspaceName: string;
  content: string;
  releaseVersion: string | null;
  updatedAt: string;
}

// The safe subset of a Plan / Report / Task list artifact served, without
// auth, at a public share link (GET /public/artifacts/:token). Dashboard
// and Release Notes have their own dedicated views above since they carry
// extra structure (dashboardData, releaseVersion); everything else is
// plain content, so one generic view covers all three.
export interface PublicArtifactView {
  type: WorkspaceArtifactType;
  title: string;
  summary: string;
  workspaceName: string;
  content: string;
  updatedAt: string;
}

export interface WorkspaceArtifactComment {
  id: string;
  artifactId: string;
  workspaceId: string;
  content: string;
  authorUserId: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceArtifactVersion {
  id: string;
  artifactId: string;
  workspaceId: string;
  version: number;
  title: string;
  summary: string;
  content: string;
  dashboardData: WorkspaceArtifactDashboard | null;
  status: WorkspaceArtifactStatus;
  savedByUserId: string | null;
  savedByName: string | null;
  createdAt: string;
}

export interface GithubIntegrationConfig {
  id?: string;
  type: "github";
  workspaceId: string;
  connectionName?: string;
  connectionScope?: ConnectionScope;
  ownerUserId?: string;
  connectedByName?: string;
  // Both are undefined right after a GitHub OAuth login completes but
  // before a repository has been chosen (see the OAuth flow in
  // services/chat-server/src/github-oauth.ts) -- `connected` is true as
  // soon as we have a working token, `repo`/`owner` land once the user
  // picks one from GithubRepoPickerModal. The pasted-token flow (still
  // supported, apps/web/app/w/[id]/integrations/page.tsx) sets all three
  // at once instead.
  owner?: string;
  repo?: string;
  // GitHub username behind this connection ("octocat"), when known.
  accountLogin?: string;
  // The token itself is never returned to the client after it's saved --
  // packages/db's read APIs omit it; only the server-side agent/integration
  // code ever sees the real value.
  connected: boolean;
  connectedAt: string;
}

export interface SlackIntegrationConfig {
  id?: string;
  type: "slack";
  workspaceId: string;
  connectionName?: string;
  connectionScope?: ConnectionScope;
  ownerUserId?: string;
  connectedByName?: string;
  teamName: string;
  connected: boolean;
  connectedAt: string;
}

export interface RemoteMcpIntegrationConfig {
  id?: string;
  type: "linear" | "notion" | "figma";
  workspaceId: string;
  connectionName?: string;
  connectionScope?: ConnectionScope;
  ownerUserId?: string;
  connectedByName?: string;
  endpoint: string;
  accountName?: string;
  // Figma only: the team whose projects and files the agent may browse
  // (Figma's API cannot list a user's teams or Drafts).
  teamId?: string;
  teamName?: string;
  connected: boolean;
  connectedAt: string;
}

export type IntegrationConfig = GithubIntegrationConfig | SlackIntegrationConfig | RemoteMcpIntegrationConfig;

// A live participant in a workspace's shared chat (ephemeral presence, not
// persisted -- who's currently connected via WebSocket). displayName
// comes from the connected socket's authenticated User (see auth.ts) --
// no longer a client-typed string a browser could claim to be anything.
export interface Participant {
  clientId: string;
  userId?: string;
  displayName: string;
  connectedAt: string;
  activeConversationId?: string;
}

// -- Agent tool-calling contract (packages/integrations implements these,
// services/chat-server's agent loop calls them) --------------------------

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
}

export interface GithubPullRequestSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  draft: boolean;
}

export interface GithubCommitSummary {
  sha: string;
  message: string;
  author: string;
  url: string;
  date: string;
}

// One repo the authenticated GitHub user/token can access -- returned by
// GET /workspaces/:id/integrations/github/repos (packages/integrations'
// listRepositoriesForToken) for the repo-picker UI, distinct from the
// deeper GithubIssueSummary/PullRequestSummary/CommitSummary shapes above
// (which describe content *inside* an already-chosen repo).
export interface GithubRepoSummary {
  owner: string;
  name: string;
  fullName: string; // "owner/name"
  private: boolean;
  description: string | null;
  updatedAt: string;
  htmlUrl: string;
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
}

export interface SlackMessageSummary {
  ts: string;
  user: string;
  text: string;
  permalink?: string;
}

// Returned by SlackClient.postMessage (packages/integrations/src/slack.ts)
// -- the write counterpart to SlackMessageSummary above. permalink is
// best-effort (chat.getPermalink needs its own scope/lookup beyond plain
// chat:write, so a bot token that can post but not fetch a permalink
// still succeeds here, just without one) -- callers should treat its
// absence as normal, not a failure.
export interface SlackPostedMessage {
  channel: string;
  ts: string;
  permalink?: string;
}

// -- Extended GitHub tool-calling contracts (full-coverage phase: code,
// branches, commits, releases, Actions/CI, labels, milestones,
// collaborators -- not just issues/PRs/commits like the original MVP
// slice above) --------------------------------------------------------

export interface GithubRepoInfo {
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  stargazersCount: number;
  openIssuesCount: number;
}

export interface GithubFileContent {
  path: string;
  sha: string;
  content: string; // decoded utf-8 text when possible, base64 for binary files
  encoding: "utf-8" | "base64";
  size: number;
  htmlUrl: string;
}

export interface GithubTreeEntry {
  path: string;
  type: "file" | "dir" | "submodule" | "symlink";
  sha: string;
  size?: number;
}

export interface GithubBranchSummary {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GithubLabelSummary {
  name: string;
  color: string;
  description: string | null;
}

export interface GithubMilestoneSummary {
  number: number;
  title: string;
  state: string;
  dueOn: string | null;
}

export interface GithubCollaboratorSummary {
  login: string;
  permission: string; // "admin" | "maintain" | "write" | "triage" | "read"
}

export interface GithubReleaseSummary {
  id: number;
  tagName: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  htmlUrl: string;
  createdAt: string;
}

export interface GithubWorkflowSummary {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GithubWorkflowRunSummary {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headBranch: string;
  createdAt: string;
}

export interface GithubPullRequestFileSummary {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GithubIssueCommentSummary {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface GithubCommitDetail {
  sha: string;
  message: string;
  author: string;
  url: string;
  date: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

// -- Pending write-action confirmation --------------------------------
// The agent can propose a repo-changing GitHub action (commit, PR merge,
// branch delete, etc.), but never performs it itself -- it queues one of
// these, a human sees it as a card in the chat UI, and only a Confirm
// click actually runs it (services/chat-server/src/actions.ts).

export type PendingActionStatus = "pending" | "confirmed" | "cancelled" | "failed";

export interface PendingAction {
  id: string;
  workspaceId: string;
  conversationId: string;
  toolName: string;
  description: string;
  // A slightly longer, more specific look at what will actually happen --
  // e.g. the real file content being committed, the full issue/PR body,
  // the reviewers being requested -- shown alongside the Confirm/Cancel
  // buttons so approving isn't a leap of faith based on the one-line
  // description alone. Null for a tool that has nothing more useful to
  // show beyond its description.
  preview: string | null;
  args: Record<string, unknown>;
  status: PendingActionStatus;
  result: string | null;
  createdAt: string;
  resolvedAt: string | null;
  // Whoever's chat message triggered the agent turn that proposed this
  // action, if known -- see the baseline migration's comment on these two columns.
  requestedByUserId?: string | null;
  requestedByName?: string | null;
  agentKind?: "project" | "github" | "slack" | "linear" | "notion" | "figma" | null;
  // Whose own connection the action runs with when approved (the requester's
  // by default).
  runAsUserId?: string | null;
  runAsName?: string | null;
  // Provider account it will act as, e.g. "@octocat" on GitHub.
  runAsAccount?: string | null;
  // False when the run-as member no longer has a usable connection; the
  // approver can then run it as themselves.
  runAsAvailable?: boolean;
  target?: ActionTarget | null;
  // Possible duplicates or conflicts found when the action was proposed.
  warnings?: ActionWarning[];
  executedAsUserId?: string | null;
  executedAsAccount?: string | null;
  // Approval rules (services/chat-server/src/approval-rules.ts). How many
  // approvals the action needs (1 unless a rule asks for more), the rule
  // that decided it, and who has approved so far.
  requiredApprovals?: number;
  approvalRuleId?: string | null;
  approvalRuleName?: string | null;
  // True when a rule approved it with no human decision.
  autoApproved?: boolean;
  approvals?: PendingActionApproval[];
  // False for workflows marked "Requires approval": no rule or standing
  // approval may approve it, so the card doesn't offer one.
  autoApproveAllowed?: boolean;
  // When the action stops waiting and is cancelled (ACTION_APPROVAL_TTL_HOURS, 24 by default).
  expiresAt?: string;
  // Exactly what will change, built when the action was proposed
  // (services/chat-server/src/change-preview.ts): a diff for file changes,
  // full text for messages and comments, from -> to for updates.
  changePreview?: ChangePreview | null;
  // Why the agent proposed it: the request that started the turn and what
  // the agent read just before, so approvers can spot an action that came
  // from text inside an issue or message rather than from a person.
  proposalContext?: ProposalContext | null;
}

export interface DiffLine {
  type: "context" | "add" | "del" | "gap";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ChangePreviewSection {
  // e.g. "README.md on main", "Comment on #18", "src/app.ts (modified, +3 -1)"
  title: string;
  kind: "diff" | "text" | "fields";
  lines?: DiffLine[];
  text?: string;
  // "from" is absent when the old value isn't known (or there is none).
  fields?: Array<{ label: string; from?: string | null; to: string }>;
  // e.g. "New file", "Showing the first 400 changed lines"
  note?: string;
}

export interface ChangePreview {
  sections: ChangePreviewSection[];
}

export interface ProposalContext {
  // The chat message (or workflow task) that started the agent turn.
  request: string | null;
  requestedBy: string | null;
  // "chat" or the workflow's name.
  source: string;
  // The agent's read calls in that turn just before it proposed this,
  // newest last. Their content was written outside Nexus.
  reads: Array<{ tool: string; summary: string; excerpt: string }>;
}

// An approver's "approve this kind of action for this target" from an
// approval card, valid for a limited time. Applies only where no approval
// rule asks for more than a normal card.
export interface StandingApproval {
  id: string;
  workspaceId: string;
  provider: IntegrationType;
  toolName: string;
  scope: string;
  // e.g. "acme/web", "#announcements", "Linear"
  scopeLabel: string;
  // e.g. "add issue comment on acme/web"
  description: string;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
}

export interface PendingActionApproval {
  userId: string;
  name: string;
  approvedAt: string;
}

// -- Approval rules -----------------------------------------------------
// Admin-defined policy for agent-proposed writes. A rule matches on tool,
// action type, repository, branch and Slack channel; when several match,
// the strictest wins: block, then the most approvals, then a normal
// approval card, then auto-approve.

export type ApprovalRuleEffect = "auto_approve" | "require_approvals" | "block";

export type ApprovalActionCategory = "create" | "comment" | "update" | "merge" | "file_change" | "branch" | "delete" | "message" | "other";

export interface ApprovalRule {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  // Null matches every tool.
  provider: IntegrationType | null;
  // Empty matches every action type.
  categories: ApprovalActionCategory[];
  // Comma-separated glob patterns, e.g. "acme/*" or "main, release/*". Null matches everything.
  repoPattern: string | null;
  branchPattern: string | null;
  channelPattern: string | null;
  effect: ApprovalRuleEffect;
  // Set when effect is "require_approvals": approvals needed from people other than the requester (1-5).
  requiredApprovals: number | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalRuleInput = Pick<ApprovalRule, "name" | "enabled" | "provider" | "categories" | "repoPattern" | "branchPattern" | "channelPattern" | "effect" | "requiredApprovals">;

export interface ApprovalDecision {
  // "default": no rule changed anything, so one approval from anyone allowed to approve.
  effect: ApprovalRuleEffect | "default";
  requiredApprovals: number;
  ruleId: string | null;
  ruleName: string | null;
}

export interface ActionTarget {
  provider: IntegrationType;
  // Stable identity used to spot two actions on the same thing.
  key: string;
  // Short human label, e.g. "issue #14 in acme/web".
  label: string;
  kind: string;
  repo?: string;
  number?: number;
  title?: string;
  path?: string;
  branch?: string;
  channel?: string;
  // Slack: the channel's name when the action names it by ID, so rules can match either.
  channelName?: string;
  // GitHub: the branch a pull request merges into, looked up for merges and PR updates.
  baseBranch?: string;
  // GitHub: what the repository's own branch protection requires on the
  // branch this action changes, shown on the card (Nexus approval comes first, then GitHub's).
  branchProtection?: { branch: string; protected: boolean; requiredReviews: number | null };
}

export interface ActionWarning {
  kind: "pending_duplicate" | "recent_duplicate" | "similar_issue" | "similar_pending";
  message: string;
  url?: string;
  actionId?: string;
}

export interface WorkspaceGithubSetup {
  // Repository webhook endpoint for this workspace (content type JSON).
  webhookUrl: string;
  // Shown to Admins only.
  webhookSecret?: string;
  events: string[];
  lastDeliveryAt: string | null;
  lastEvent: string | null;
  // The repository the viewing member works in ("owner/repo"), if chosen.
  myRepository: string | null;
  // Every repository a member of this workspace works in. GitHub events
  // from these repositories are accepted.
  repositories: string[];
}

// One recent thing a teammate (or GitHub itself) did, shown live in chat.
export interface TeamActivity {
  id: string;
  source: "nexus" | "github";
  actorName: string;
  summary: string;
  repo: string | null;
  url: string | null;
  createdAt: string;
}

// -- Action audit trail (docs/spec.md Phase 2: "who asked for what, what
// the agent did, when") -----------------------------------------------
// A single append-only log of notable workspace events -- who did what
// and when, across both humans and the agent. See
// services/chat-server/src/audit.ts for how these get written and
// packages/db's audit_events table/schema comment for the storage shape.

export type AuditActorType = "user" | "agent" | "system";

// Kept as a plain string union rather than a generic `string` so the
// frontend's type filter dropdown and any future event type stay in sync
// with what the backend actually writes -- add a new kind here and in
// audit.ts's EVENT_TYPES list together.
export type AuditEventType =
  | "workspace.created"
  | "member.joined"
  | "member.left"
  | "member.invited"
  | "integration.connected"
  | "workspace.permissions_updated"
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "agent.published"
  | "workflow.created"
  | "workflow.updated"
  | "workflow.deleted"
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  | "memory.created"
  | "memory.updated"
  | "memory.deleted"
  | "artifact.created"
  | "artifact.updated"
  | "artifact.deleted"
  | "artifact.commented"
  | "action.proposed"
  | "action.confirmed"
  | "action.cancelled"
  | "action.failed"
  // Approval rules: one approval recorded on an action that needs several,
  // an action a rule ran without a human decision, and one a rule refused.
  | "action.approved"
  | "action.auto_approved"
  | "action.blocked"
  | "action.expired"
  | "standing_approval.created"
  | "standing_approval.revoked"
  | "approval_rule.created"
  | "approval_rule.updated"
  | "approval_rule.deleted"
  // Logged whenever a message @-mentions one or more teammates without
  // also @-mentioning the agent -- see mentions_agent's sql/migrations/0001_baseline.sql
  // comment. Gives "who's driving this" a durable, searchable trail
  // (docs/spec.md: "so who's driving this stays visible"), on top of the
  // handoff message itself being visible live in the chat.
  | "handoff.directed"
  // Archiving, restoring and deleting a conversation are Admin-only and
  // recorded so a removed or hidden chat always has an attributable trail.
  | "conversation.archived"
  | "conversation.restored"
  | "conversation.deleted"
  // Workspace repository list changes and verified GitHub webhook events.
  | "repository.added"
  | "repository.removed"
  | "repository.updated"
  | "github.event";

export interface AuditEvent {
  id: string;
  workspaceId: string;
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorUserId: string | null;
  actorName: string;
  // A one-line, already-formatted human description of what happened --
  // e.g. "Dhaval confirmed: open a PR to fix the failing test" -- so the
  // UI can just render it, the same "denormalize for display" choice
  // messages.author_name and pending_actions.description already make.
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
