// Approval rules engine (src/approval-rules.ts): matching, precedence and
// input validation. Pure functions, no database.
import { describe, it, expect } from "vitest";
import type { ApprovalRule, ActionTarget } from "@mai-chat/shared-types";
import { actionCategory, actionFacts, evaluateApprovalRules, globMatch, parseApprovalRuleInput, ruleMatches, standingScope, type ActionFacts } from "../src/approval-rules.js";
import { describeActionTarget } from "../src/github-team.js";

let seq = 0;
function rule(overrides: Partial<ApprovalRule>): ApprovalRule {
  seq += 1;
  return {
    id: `rule-${seq}`,
    workspaceId: "ws",
    name: `Rule ${seq}`,
    enabled: true,
    provider: null,
    categories: [],
    repoPattern: null,
    branchPattern: null,
    channelPattern: null,
    effect: "require_approvals",
    requiredApprovals: 2,
    createdByName: "Admin",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const githubMergeToMain: ActionFacts = { provider: "github", category: "merge", repo: "acme/web", branch: "main", channels: null };
const githubComment: ActionFacts = { provider: "github", category: "comment", repo: "acme/web", branch: null, channels: null };
const slackMessage: ActionFacts = { provider: "slack", category: "message", repo: null, branch: null, channels: ["general"] };

describe("globMatch", () => {
  it("matches exact values case-insensitively", () => {
    expect(globMatch("acme/Web", "ACME/web")).toBe(true);
    expect(globMatch("acme/web", "acme/website")).toBe(false);
  });
  it("treats * as any run of characters and escapes everything else", () => {
    expect(globMatch("acme/*", "acme/web")).toBe(true);
    expect(globMatch("release/*", "release/2026.10")).toBe(true);
    expect(globMatch("release/*", "main")).toBe(false);
    expect(globMatch("a.c", "abc")).toBe(false);
  });
  it("ignores a leading # on channels", () => {
    expect(globMatch("#eng-*", "eng-alerts")).toBe(true);
  });
});

describe("evaluateApprovalRules", () => {
  it("gives a normal approval card when nothing matches", () => {
    expect(evaluateApprovalRules([], githubComment)).toEqual({ effect: "default", requiredApprovals: 1, ruleId: null, ruleName: null });
    expect(evaluateApprovalRules([rule({ provider: "slack" })], githubComment).effect).toBe("default");
  });

  it("strictest wins regardless of order: block > more approvals > fewer approvals > auto-approve", () => {
    const auto = rule({ effect: "auto_approve", requiredApprovals: null });
    const two = rule({ requiredApprovals: 2 });
    const three = rule({ requiredApprovals: 3 });
    const block = rule({ effect: "block", requiredApprovals: null });
    expect(evaluateApprovalRules([auto, two, three], githubComment)).toMatchObject({ effect: "require_approvals", requiredApprovals: 3, ruleId: three.id });
    expect(evaluateApprovalRules([three, auto, two], githubComment).ruleId).toBe(three.id);
    expect(evaluateApprovalRules([auto, block, three], githubComment)).toMatchObject({ effect: "block", ruleId: block.id });
    expect(evaluateApprovalRules([auto], githubComment)).toMatchObject({ effect: "auto_approve", ruleId: auto.id });
  });

  it("can switch auto-approve off (workflows marked Requires approval, approval-time re-checks)", () => {
    const auto = rule({ effect: "auto_approve", requiredApprovals: null });
    expect(evaluateApprovalRules([auto], githubComment, { allowAutoApprove: false }).effect).toBe("default");
    const block = rule({ effect: "block", requiredApprovals: null });
    expect(evaluateApprovalRules([auto, block], githubComment, { allowAutoApprove: false }).effect).toBe("block");
  });

  it("skips disabled rules", () => {
    expect(evaluateApprovalRules([rule({ effect: "block", enabled: false })], githubComment).effect).toBe("default");
  });
});

describe("ruleMatches", () => {
  it("matches on tool, action type, repository and branch", () => {
    const productionMerges = rule({ provider: "github", categories: ["merge"], repoPattern: "acme/*", branchPattern: "main, release/*" });
    expect(ruleMatches(productionMerges, githubMergeToMain)).toBe(true);
    expect(ruleMatches(productionMerges, { ...githubMergeToMain, branch: "feature/x" })).toBe(false);
    expect(ruleMatches(productionMerges, { ...githubMergeToMain, repo: "other/web" })).toBe(false);
    expect(ruleMatches(productionMerges, { ...githubMergeToMain, category: "comment" })).toBe(false);
    expect(ruleMatches(productionMerges, slackMessage)).toBe(false);
  });

  it("an unknown branch counts as a match for block and approval rules, never for auto-approve", () => {
    const unknownBranch = { ...githubMergeToMain, branch: null };
    expect(ruleMatches(rule({ branchPattern: "main" }), unknownBranch)).toBe(true);
    expect(ruleMatches(rule({ effect: "block", branchPattern: "main" }), unknownBranch)).toBe(true);
    expect(ruleMatches(rule({ effect: "auto_approve", branchPattern: "main" }), unknownBranch)).toBe(false);
  });

  it("repository and branch patterns only match GitHub actions; channel patterns only Slack", () => {
    expect(ruleMatches(rule({ repoPattern: "acme/*" }), slackMessage)).toBe(false);
    expect(ruleMatches(rule({ channelPattern: "general" }), githubComment)).toBe(false);
    expect(ruleMatches(rule({ channelPattern: "gen*" }), slackMessage)).toBe(true);
    expect(ruleMatches(rule({ channelPattern: "random" }), slackMessage)).toBe(false);
  });
});

describe("actionFacts", () => {
  it("uses the base branch of a new pull request", () => {
    const args = { owner: "acme", repo: "web", head: "fix/login", base: "main", title: "Fix login" };
    const facts = actionFacts("create_pull_request", args, describeActionTarget("create_pull_request", args, "github"));
    expect(facts).toEqual({ provider: "github", category: "create", repo: "acme/web", branch: "main", channels: null });
  });

  it("uses the branch of a file change, and reports an unknown branch when none is given", () => {
    const withBranch = { owner: "acme", repo: "web", path: "README.md", branch: "release/1.2", content: "x" };
    expect(actionFacts("create_or_update_file", withBranch, describeActionTarget("create_or_update_file", withBranch, "github"))).toMatchObject({ category: "file_change", branch: "release/1.2" });
    const merge = { owner: "acme", repo: "web", pullNumber: 12 };
    expect(actionFacts("merge_pull_request", merge, describeActionTarget("merge_pull_request", merge, "github"))).toMatchObject({ category: "merge", branch: null });
  });

  it("reads the Slack channel", () => {
    const args = { channel_id: "#announcements", message: "hello" };
    expect(actionFacts("slack_send_message", args, describeActionTarget("slack_send_message", args, "slack"))).toMatchObject({ provider: "slack", category: "message", channels: ["announcements"] });
  });

  it("matches a Slack channel by ID or by its looked-up name", () => {
    const args = { channel_id: "C024BE91L", message: "hello" };
    const target = { ...describeActionTarget("slack_send_message", args, "slack"), channelName: "announcements" };
    const facts = actionFacts("slack_send_message", args, target);
    expect(facts.channels).toEqual(["C024BE91L", "announcements"]);
    expect(ruleMatches(rule({ channelPattern: "announcements" }), facts)).toBe(true);
    expect(ruleMatches(rule({ channelPattern: "C024BE91L" }), facts)).toBe(true);
  });

  it("treats a Slack ID whose name couldn't be looked up as unknown", () => {
    const args = { channel_id: "C024BE91L", message: "hello" };
    const facts = actionFacts("slack_send_message", args, describeActionTarget("slack_send_message", args, "slack"));
    expect(facts.channels).toBeNull();
    expect(ruleMatches(rule({ channelPattern: "announcements" }), facts)).toBe(true);
    expect(ruleMatches(rule({ effect: "auto_approve", channelPattern: "announcements" }), facts)).toBe(false);
  });

  it("never treats the “default branch” label as a branch name", () => {
    const args = { owner: "acme", repo: "web", path: "README.md", content: "x" };
    const target = describeActionTarget("create_or_update_file", args, "github");
    expect(target.branch).toBe("default branch");
    expect(actionFacts("create_or_update_file", args, target).branch).toBeNull();
    // The proposal step fills in the repository's real default branch.
    expect(actionFacts("create_or_update_file", args, { ...target, baseBranch: "main" }).branch).toBe("main");
  });

  it("uses a merge's looked-up base branch", () => {
    const merge = { owner: "acme", repo: "web", pullNumber: 12 };
    const target = { ...describeActionTarget("merge_pull_request", merge, "github"), baseBranch: "release/2.4" };
    expect(actionFacts("merge_pull_request", merge, target).branch).toBe("release/2.4");
  });

  it("classifies deletes before anything else", () => {
    const target: ActionTarget = { provider: "github", key: "k", label: "l", kind: "file", repo: "acme/web", path: "a.txt" };
    expect(actionCategory("delete_file", target)).toBe("delete");
  });
});

describe("parseApprovalRuleInput", () => {
  it("accepts and normalizes a valid rule", () => {
    const parsed = parseApprovalRuleInput({ name: "  Prod merges ", effect: "require_approvals", requiredApprovals: 2, provider: "github", categories: ["merge", "merge"], repoPattern: " acme/* ", branchPattern: "main,release/*" });
    expect(parsed).toEqual({ input: { name: "Prod merges", enabled: true, provider: "github", categories: ["merge"], repoPattern: "acme/*", branchPattern: "main, release/*", channelPattern: null, effect: "require_approvals", requiredApprovals: 2 } });
  });

  it("drops the approval count for effects that don't use it", () => {
    expect(parseApprovalRuleInput({ name: "Block deletes", effect: "block", requiredApprovals: 3 })).toMatchObject({ input: { requiredApprovals: null } });
  });

  it("rejects bad input with a readable message", () => {
    expect(parseApprovalRuleInput({ effect: "block" })).toEqual({ error: "Give the rule a name of 1 to 100 characters." });
    expect(parseApprovalRuleInput({ name: "x", effect: "maybe" })).toHaveProperty("error");
    expect(parseApprovalRuleInput({ name: "x", effect: "require_approvals", requiredApprovals: 9 })).toHaveProperty("error");
    expect(parseApprovalRuleInput({ name: "x", effect: "block", provider: "jira" })).toHaveProperty("error");
    expect(parseApprovalRuleInput({ name: "x", effect: "block", categories: ["explode"] })).toHaveProperty("error");
    expect(parseApprovalRuleInput({ name: "x", effect: "block", provider: "slack", repoPattern: "acme/web" })).toEqual({ error: "Repository and branch apply to GitHub rules only." });
    expect(parseApprovalRuleInput({ name: "x", effect: "block", provider: "github", channelPattern: "general" })).toEqual({ error: "Channel applies to Slack rules only." });
    expect(parseApprovalRuleInput({ name: "x", effect: "block", repoPattern: "web" })).toHaveProperty("error");
    expect(parseApprovalRuleInput({ name: "x", effect: "block", branchPattern: "main; drop table" })).toHaveProperty("error");
  });
});

describe("standingScope", () => {
  it("covers a GitHub repository, a Slack channel, or the whole tool", () => {
    expect(standingScope({ provider: "github", key: "k", label: "l", kind: "comment", repo: "Acme/Web" })).toEqual({ scope: "github:acme/web", label: "Acme/Web" });
    expect(standingScope({ provider: "slack", key: "k", label: "l", kind: "message", channel: "C024BE91L", channelName: "eng" })).toEqual({ scope: "slack:c024be91l", label: "#eng" });
    expect(standingScope({ provider: "linear", key: "k", label: "l", kind: "comment" })).toEqual({ scope: "linear", label: "Linear" });
  });
});
