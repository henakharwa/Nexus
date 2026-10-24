// Approval rules engine: decides what happens to an agent-proposed write.
//
// Admins define rules per workspace (Approvals page). Each rule matches on
// tool, action type, repository, branch and Slack channel, and has one
// effect:
//   - block:             the action is refused before anyone is asked;
//   - require_approvals: N people other than the requester must approve;
//   - auto_approve:      the action runs at once as the requester.
// With no matching rule, the action gets a normal approval card (one
// approval from anyone allowed to approve), which is how Nexus worked
// before rules existed.
//
// When several rules match, the strictest wins: block, then the highest
// approval count, then the normal card, then auto-approve. Rule order never
// matters, so adding a permissive rule can't weaken a stricter one.
//
// When Nexus can't tell a value a rule asks about (for example, which
// branch a merge goes into), restrictive rules (block, require approvals)
// still apply and auto-approve rules don't. Not knowing never makes an
// action easier to run.
import type { ActionTarget, ApprovalActionCategory, ApprovalDecision, ApprovalRule, ApprovalRuleInput, IntegrationType } from "@mai-chat/shared-types";

export const APPROVAL_CATEGORIES: ApprovalActionCategory[] = ["create", "comment", "update", "merge", "file_change", "branch", "delete", "message", "other"];
export const RULE_PROVIDERS: IntegrationType[] = ["github", "slack", "linear", "notion", "figma"];
export const MAX_RULES_PER_WORKSPACE = 50;
export const MAX_REQUIRED_APPROVALS = 5;

/** The facts about one action that rules can match on. Null means "not known". */
export interface ActionFacts {
  provider: IntegrationType;
  category: ApprovalActionCategory;
  repo: string | null;
  branch: string | null;
  // Slack: the channel as the action names it plus its name when known
  // (rules may use either). Null when only an ID is known and its name
  // couldn't be looked up.
  channels: string[] | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export function actionCategory(toolName: string, target: ActionTarget): ApprovalActionCategory {
  if (/delete|archive/i.test(toolName)) return "delete";
  switch (target.kind) {
    case "new_issue":
    case "new_pull_request":
      return "create";
    case "comment":
      return "comment";
    case "merge":
      return "merge";
    case "issue_update":
    case "pull_request_update":
    case "page_update":
    case "append":
      return "update";
    case "file":
      return "file_change";
    case "branch":
      return "branch";
    case "message":
      return "message";
    default:
      if (/merge/i.test(toolName)) return "merge";
      if (/comment/i.test(toolName)) return "comment";
      if (/push|file/i.test(toolName)) return "file_change";
      if (/create|save|new/i.test(toolName)) return "create";
      if (/update|edit/i.test(toolName)) return "update";
      return "other";
  }
}

/** Slack IDs look like C024BE91L (channels), G... (private) or D... (DMs). */
export function isSlackId(value: string): boolean {
  return /^[CGD][A-Z0-9]{8,}$/.test(value);
}

/**
 * The branch an action lands on. For a pull request that's where it merges
 * to, not where it comes from. When the arguments don't say, the branch the
 * proposal step looked up (a merge's base, or the repository's default
 * branch for a file change) is used. Null when nothing is known.
 */
function landingBranch(toolName: string, args: Record<string, unknown>, target: ActionTarget): string | null {
  if (toolName === "create_pull_request") return text(args.base) ?? target.baseBranch ?? null;
  if (target.kind === "branch") return null;
  // describeActionTarget labels a file change with no branch "default branch"; that's not a branch name.
  const named = text(args.branch) ?? (target.branch && target.branch !== "default branch" && target.kind !== "new_pull_request" ? target.branch : null);
  return named ?? target.baseBranch ?? null;
}

export function actionFacts(toolName: string, args: Record<string, unknown>, target: ActionTarget): ActionFacts {
  const provider = target.provider;
  let channels: string[] | null = null;
  if (provider === "slack") {
    const raw = text(args.channel_name) ?? text(args.channel) ?? text(args.channel_id) ?? (target.channel && target.channel !== "unknown" ? target.channel : null);
    const named = raw ? raw.replace(/^#/, "") : null;
    const name = target.channelName ? target.channelName.replace(/^#/, "") : null;
    // An ID whose name couldn't be looked up is "unknown" to a rule written
    // with a channel name, so restrictive rules still apply to it.
    if (named && !(isSlackId(named) && !name)) channels = [...new Set([named, ...(name ? [name] : [])])];
  }
  return {
    provider,
    category: actionCategory(toolName, target),
    repo: provider === "github" ? target.repo ?? null : null,
    branch: provider === "github" ? landingBranch(toolName, args, target) : null,
    channels,
  };
}

/**
 * What a standing approval covers for this action: the tool plus its
 * repository (GitHub), channel (Slack) or the whole tool elsewhere.
 */
export function standingScope(target: ActionTarget): { scope: string; label: string } {
  if (target.provider === "github" && target.repo) return { scope: `github:${target.repo.toLowerCase()}`, label: target.repo };
  if (target.provider === "slack" && target.channel && target.channel !== "unknown") {
    const channel = target.channel.replace(/^#/, "");
    return { scope: `slack:${channel.toLowerCase()}`, label: `#${(target.channelName ?? channel).replace(/^#/, "")}` };
  }
  const labels: Record<IntegrationType, string> = { github: "GitHub", slack: "Slack", linear: "Linear", notion: "Notion", figma: "Figma" };
  return { scope: target.provider, label: labels[target.provider] };
}

/** Splits "main, release/*" into trimmed patterns. */
export function splitPatterns(pattern: string | null | undefined): string[] {
  return (pattern ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

/** Case-insensitive glob match where "*" matches any run of characters. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.toLowerCase().replace(/^#/, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value.toLowerCase());
}

function fieldMatches(pattern: string | null, value: string | string[] | null, restrictive: boolean): boolean {
  const patterns = splitPatterns(pattern);
  if (patterns.length === 0) return true;
  if (value === null) return restrictive;
  const values = Array.isArray(value) ? value : [value];
  return patterns.some((one) => values.some((candidate) => globMatch(one, candidate)));
}

export function ruleMatches(rule: ApprovalRule, facts: ActionFacts): boolean {
  if (!rule.enabled) return false;
  if (rule.provider && rule.provider !== facts.provider) return false;
  if (rule.categories.length > 0 && !rule.categories.includes(facts.category)) return false;
  const restrictive = rule.effect !== "auto_approve";
  // Repository and branch only describe GitHub actions, channel only Slack
  // ones. A rule for "any tool" with a repository pattern therefore never
  // matches a Slack message.
  if (splitPatterns(rule.repoPattern).length && facts.provider !== "github") return false;
  if (splitPatterns(rule.branchPattern).length && facts.provider !== "github") return false;
  if (splitPatterns(rule.channelPattern).length && facts.provider !== "slack") return false;
  return fieldMatches(rule.repoPattern, facts.repo, restrictive) && fieldMatches(rule.branchPattern, facts.branch, restrictive) && fieldMatches(rule.channelPattern, facts.channels, restrictive);
}

function strictness(rule: ApprovalRule): number {
  if (rule.effect === "block") return 100;
  if (rule.effect === "require_approvals") return 10 + (rule.requiredApprovals ?? 1);
  return 0;
}

export const DEFAULT_DECISION: ApprovalDecision = { effect: "default", requiredApprovals: 1, ruleId: null, ruleName: null };

/**
 * Decides what happens to an action. `allowAutoApprove: false` turns an
 * auto-approve result into a normal card (used for workflows marked
 * "Requires approval", and when re-checking at approval time).
 */
export function evaluateApprovalRules(rules: ApprovalRule[], facts: ActionFacts, options: { allowAutoApprove?: boolean } = {}): ApprovalDecision {
  const matching = rules.filter((rule) => ruleMatches(rule, facts));
  if (matching.length === 0) return DEFAULT_DECISION;
  const strictest = matching.reduce((best, rule) => (strictness(rule) > strictness(best) ? rule : best));
  if (strictest.effect === "auto_approve") {
    return options.allowAutoApprove === false ? DEFAULT_DECISION : { effect: "auto_approve", requiredApprovals: 0, ruleId: strictest.id, ruleName: strictest.name };
  }
  if (strictest.effect === "block") return { effect: "block", requiredApprovals: 0, ruleId: strictest.id, ruleName: strictest.name };
  return { effect: "require_approvals", requiredApprovals: strictest.requiredApprovals ?? 1, ruleId: strictest.id, ruleName: strictest.name };
}

const PATTERN_RE = /^[A-Za-z0-9_.\-/*#, ]*$/;

/** Validates and normalizes a rule from a request body. Returns an error message or the input. */
export function parseApprovalRuleInput(body: unknown): { error: string } | { input: ApprovalRuleInput } {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 100) return { error: "Give the rule a name of 1 to 100 characters." };
  const effect = source.effect;
  if (effect !== "auto_approve" && effect !== "require_approvals" && effect !== "block") return { error: "Choose what the rule does: auto-approve, require approvals or block." };
  let requiredApprovals: number | null = null;
  if (effect === "require_approvals") {
    const count = Number(source.requiredApprovals);
    if (!Number.isInteger(count) || count < 1 || count > MAX_REQUIRED_APPROVALS) return { error: `Required approvals must be a whole number from 1 to ${MAX_REQUIRED_APPROVALS}.` };
    requiredApprovals = count;
  }
  const provider = source.provider === null || source.provider === undefined || source.provider === "" ? null : source.provider;
  if (provider !== null && !RULE_PROVIDERS.includes(provider as IntegrationType)) return { error: "Unknown tool." };
  const rawCategories = Array.isArray(source.categories) ? source.categories : [];
  if (rawCategories.some((category) => !APPROVAL_CATEGORIES.includes(category as ApprovalActionCategory))) return { error: "Unknown action type." };
  const categories = [...new Set(rawCategories as ApprovalActionCategory[])];
  const pattern = (key: "repoPattern" | "branchPattern" | "channelPattern", label: string): { error: string } | { value: string | null } => {
    const value = source[key];
    if (value === null || value === undefined) return { value: null };
    if (typeof value !== "string") return { error: `${label} must be text.` };
    const trimmed = splitPatterns(value).join(", ");
    if (trimmed.length > 200) return { error: `${label} can be up to 200 characters.` };
    if (!PATTERN_RE.test(trimmed)) return { error: `${label} can use letters, numbers, - _ . / # and * only.` };
    return { value: trimmed || null };
  };
  const repo = pattern("repoPattern", "Repository");
  if ("error" in repo) return repo;
  const branch = pattern("branchPattern", "Branch");
  if ("error" in branch) return branch;
  const channel = pattern("channelPattern", "Channel");
  if ("error" in channel) return channel;
  if ((repo.value || branch.value) && provider !== null && provider !== "github") return { error: "Repository and branch apply to GitHub rules only." };
  if (channel.value && provider !== null && provider !== "slack") return { error: "Channel applies to Slack rules only." };
  if (repo.value && !splitPatterns(repo.value).every((one) => one.includes("/"))) return { error: "Write repositories as owner/name, e.g. acme/web or acme/*." };
  return {
    input: {
      name,
      enabled: source.enabled === undefined ? true : Boolean(source.enabled),
      provider: provider as IntegrationType | null,
      categories,
      repoPattern: repo.value,
      branchPattern: branch.value,
      channelPattern: channel.value,
      effect,
      requiredApprovals,
    },
  };
}

/**
 * The recommended starting policy, offered in one click on the Approvals
 * page: hard-block deletes (like QM's command policy), extra review for
 * production code, and no friction for comments. The production rule asks
 * for two approvers only when the workspace has enough people who can
 * approve (the requester can't be one of them); otherwise one.
 */
export function starterRules(approvers: number): ApprovalRuleInput[] {
  const productionApprovals = approvers >= 3 ? 2 : 1;
  return [
    { name: "Block deletes and archives", enabled: true, provider: null, categories: ["delete"], repoPattern: null, branchPattern: null, channelPattern: null, effect: "block", requiredApprovals: null },
    {
      name: productionApprovals === 2 ? "Production changes need two people" : "Production changes need a second person",
      enabled: true,
      provider: "github",
      categories: ["merge", "file_change"],
      repoPattern: null,
      branchPattern: "main, master, release/*",
      channelPattern: null,
      effect: "require_approvals",
      requiredApprovals: productionApprovals,
    },
    { name: "Comments run without approval", enabled: true, provider: null, categories: ["comment"], repoPattern: null, branchPattern: null, channelPattern: null, effect: "auto_approve", requiredApprovals: null },
  ];
}
