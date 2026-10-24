"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type {
  ApprovalActionCategory,
  ApprovalRule,
  ApprovalRuleEffect,
  ApprovalRuleInput,
  IntegrationType,
  StandingApproval,
} from "@mai-chat/shared-types";
import { useDialog } from "../../../_components/DialogProvider";
import {
  addStarterApprovalRules,
  createApprovalRule,
  deleteApprovalRule,
  describeError,
  getApprovalCapacity,
  listApprovalRules,
  listStandingApprovals,
  revokeStandingApproval,
  updateApprovalRule,
} from "../../../../lib/api";
import { useCurrentUser } from "../../../../lib/useCurrentUser";
import { useWorkspaceAccess } from "../../../../lib/useWorkspaceAccess";

// Approval rules (services/chat-server/src/approval-rules.ts): Admin-defined
// policy for the agent's proposed writes. Every member can read the rules;
// only Admins can change them.

const EFFECTS: Array<{ value: ApprovalRuleEffect; label: string; help: string }> = [
  { value: "auto_approve", label: "Auto-approve", help: "Runs right away as the requester. Use for low-risk changes." },
  {
    value: "require_approvals",
    label: "Require approvals",
    help: "Waits for approvals from people other than the requester.",
  },
  { value: "block", label: "Block", help: "Never runs. The agent is told which rule stopped it." },
];

const PROVIDERS: Array<{ value: IntegrationType | ""; label: string }> = [
  { value: "", label: "Any tool" },
  { value: "github", label: "GitHub" },
  { value: "slack", label: "Slack" },
  { value: "linear", label: "Linear" },
  { value: "notion", label: "Notion" },
  { value: "figma", label: "Figma" },
];

const CATEGORIES: Array<{ value: ApprovalActionCategory; label: string }> = [
  { value: "create", label: "Create (issues, PRs)" },
  { value: "comment", label: "Comment" },
  { value: "update", label: "Update" },
  { value: "merge", label: "Merge" },
  { value: "file_change", label: "File change / push" },
  { value: "branch", label: "Create branch" },
  { value: "delete", label: "Delete or archive" },
  { value: "message", label: "Slack message" },
  { value: "other", label: "Other" },
];

type Draft = {
  name: string;
  enabled: boolean;
  provider: IntegrationType | "";
  categories: ApprovalActionCategory[];
  repoPattern: string;
  branchPattern: string;
  channelPattern: string;
  effect: ApprovalRuleEffect;
  requiredApprovals: number;
};

const blank: Draft = {
  name: "",
  enabled: true,
  provider: "",
  categories: [],
  repoPattern: "",
  branchPattern: "",
  channelPattern: "",
  effect: "require_approvals",
  requiredApprovals: 2,
};

function toDraft(rule: ApprovalRule): Draft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    provider: rule.provider ?? "",
    categories: rule.categories,
    repoPattern: rule.repoPattern ?? "",
    branchPattern: rule.branchPattern ?? "",
    channelPattern: rule.channelPattern ?? "",
    effect: rule.effect,
    requiredApprovals: rule.requiredApprovals ?? 2,
  };
}

function toInput(draft: Draft): ApprovalRuleInput {
  const githubFields = draft.provider === "" || draft.provider === "github";
  const slackFields = draft.provider === "" || draft.provider === "slack";
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    provider: draft.provider || null,
    categories: draft.categories,
    repoPattern: githubFields ? draft.repoPattern.trim() || null : null,
    branchPattern: githubFields ? draft.branchPattern.trim() || null : null,
    channelPattern: slackFields ? draft.channelPattern.trim() || null : null,
    effect: draft.effect,
    requiredApprovals: draft.effect === "require_approvals" ? draft.requiredApprovals : null,
  };
}

/** One sentence saying what a rule does, e.g. "GitHub merges in acme/* on main need 2 approvals". */
function summarizeRule(rule: ApprovalRuleInput): string {
  const tool = PROVIDERS.find((provider) => provider.value === (rule.provider ?? ""))?.label ?? "Any tool";
  const kinds = rule.categories.length
    ? rule.categories
        .map((category) => CATEGORIES.find((item) => item.value === category)?.label.toLowerCase() ?? category)
        .join(", ")
    : "any action";
  const where = [
    rule.repoPattern ? `in ${rule.repoPattern}` : "",
    rule.branchPattern ? `on ${rule.branchPattern}` : "",
    rule.channelPattern ? `in #${rule.channelPattern.replace(/^#/, "")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const what =
    rule.effect === "block"
      ? "is blocked"
      : rule.effect === "auto_approve"
        ? "runs without approval"
        : `needs ${rule.requiredApprovals} approval${rule.requiredApprovals === 1 ? "" : "s"} from people other than the requester`;
  return `${tool}: ${kinds}${where ? ` ${where}` : ""} ${what}.`;
}

/**
 * Why a rule asking for `required` approvers can't always be met, given how
 * many members can approve. Approvers must be people other than the
 * requester, so when an approver asks, one fewer is available.
 */
function capacityWarning(required: number, approvers: number | null): string | null {
  if (approvers === null || required < approvers) return null;
  const people = `${approvers} ${approvers === 1 ? "person" : "people"}`;
  if (required > approvers) return `Only ${people} can approve actions here, so this rule can never be met.`;
  if (approvers === 1) return "Only 1 person can approve actions here, so when they ask, nobody else can approve it.";
  return `Only ${people} can approve actions here, so when one of them asks, just ${approvers - 1} other${approvers - 1 === 1 ? "" : "s"} can approve, not ${required}.`;
}

const EFFECT_LABELS: Record<ApprovalRuleEffect, string> = {
  auto_approve: "Auto-approve",
  require_approvals: "Approvals",
  block: "Block",
};

export default function ApprovalsPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const access = useWorkspaceAccess(workspaceId);
  const dialog = useDialog();
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ApprovalRule | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canChange = access.isAdmin;
  const { user } = useCurrentUser();
  const [approvers, setApprovers] = useState<number | null>(null);
  const [standing, setStanding] = useState<StandingApproval[]>([]);

  const refresh = () =>
    Promise.all([
      listApprovalRules(workspaceId).then(setRules),
      getApprovalCapacity(workspaceId).then((capacity) => setApprovers(capacity.approvers)),
      listStandingApprovals(workspaceId).then(setStanding),
    ])
      .catch((reason: unknown) => setError(describeError(reason, "Could not load approval rules.")))
      .finally(() => setLoading(false));

  async function addStarter() {
    setSaving(true);
    setError("");
    try {
      const created = await addStarterApprovalRules(workspaceId);
      await refresh();
      setNotice(
        `Added ${created.length} recommended rule${created.length === 1 ? "" : "s"}. Edit or turn off any of them.`,
      );
    } catch (reason) {
      setError(describeError(reason, "Could not add the recommended rules."));
    } finally {
      setSaving(false);
    }
  }
  async function revoke(approval: StandingApproval) {
    if (
      !(await dialog.confirm({
        title: "Revoke this standing approval?",
        message: `${approval.description} will need an approval card again.`,
        confirmLabel: "Revoke",
        danger: true,
      }))
    )
      return;
    try {
      await revokeStandingApproval(workspaceId, approval.id);
      await refresh();
    } catch (reason) {
      setError(describeError(reason, "Could not revoke the standing approval."));
    }
  }
  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  function startNew() {
    setSelected(null);
    setDraft(blank);
    setError("");
    setNotice("");
  }
  function edit(rule: ApprovalRule) {
    setSelected(rule);
    setDraft(toDraft(rule));
    setError("");
    setNotice("");
  }
  function toggleCategory(category: ApprovalActionCategory) {
    setDraft((current) => ({
      ...current,
      categories: current.categories.includes(category)
        ? current.categories.filter((item) => item !== category)
        : [...current.categories, category],
    }));
  }
  async function save() {
    if (!draft.name.trim()) {
      setError("Give the rule a name.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = selected
        ? await updateApprovalRule(workspaceId, selected.id, toInput(draft))
        : await createApprovalRule(workspaceId, toInput(draft));
      await refresh();
      setSelected(saved);
      setDraft(toDraft(saved));
      setNotice(selected ? "Rule saved." : "Rule created. It applies to the next action the agent proposes.");
    } catch (reason) {
      setError(describeError(reason, "Could not save the rule."));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (
      !selected ||
      !(await dialog.confirm({
        title: `Delete ${selected.name}?`,
        message: "Actions it matched go back to the other rules, or to a normal approval card.",
        confirmLabel: "Delete rule",
        danger: true,
      }))
    )
      return;
    setSaving(true);
    try {
      await deleteApprovalRule(workspaceId, selected.id);
      startNew();
      await refresh();
    } catch (reason) {
      setError(describeError(reason, "Could not delete the rule."));
    } finally {
      setSaving(false);
    }
  }

  const showGithubFields = draft.provider === "" || draft.provider === "github";
  const showSlackFields = draft.provider === "" || draft.provider === "slack";

  return (
    <main className="workspace-settings-page approvals-page">
      <header>
        <p className="eyebrow">APPROVAL RULES</p>
        <h1>Decide what needs a human</h1>
        <p>
          Set which agent actions run on their own, which need more than one approver, and which are never allowed.
          Actions no rule matches get a normal approval card.
        </p>
      </header>
      <section className="approval-rules-explainer" aria-label="How rules combine">
        <div>
          <strong>Strictest rule wins</strong>
          <span>Block, then the most approvals, then a normal card, then auto-approve. Order doesn&apos;t matter.</span>
        </div>
        <div>
          <strong>Requesters don&apos;t approve their own</strong>
          <span>Under a rule, approvals must come from people other than the person who asked the agent.</span>
        </div>
        <div>
          <strong>Unknown counts as a match</strong>
          <span>
            If Nexus can&apos;t tell a branch or channel, block and approval rules still apply; auto-approve
            doesn&apos;t.
          </span>
        </div>
      </section>
      <div className="memory-layout">
        <section className="memory-list">
          <div className="section-heading">
            <h2>Rules</h2>
            <button disabled={!canChange} onClick={startNew}>
              New rule
            </button>
          </div>
          {rules.length ? (
            rules.map((rule) => (
              <button
                key={rule.id}
                className={`memory-card approval-rule-card ${selected?.id === rule.id ? "selected" : ""}`}
                onClick={() => edit(rule)}
                data-testid="approval-rule-card"
              >
                <span className={`approval-effect ${rule.effect}`}>
                  {rule.effect === "require_approvals"
                    ? `${rule.requiredApprovals} approver${rule.requiredApprovals === 1 ? "" : "s"}`
                    : EFFECT_LABELS[rule.effect]}
                </span>
                <strong>
                  {rule.name}
                  {!rule.enabled && <em className="approval-rule-off"> · off</em>}
                </strong>
                <small>{summarizeRule(rule)}</small>
                {rule.enabled &&
                  rule.effect === "require_approvals" &&
                  capacityWarning(rule.requiredApprovals ?? 1, approvers) && (
                    <small className="approval-rule-warning" data-testid="approval-rule-warning">
                      {capacityWarning(rule.requiredApprovals ?? 1, approvers)}
                    </small>
                  )}
              </button>
            ))
          ) : loading ? (
            <div className="list-loading" role="status" aria-label="Loading approval rules">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <div className="approval-starter">
              <p className="muted">No rules yet. Every agent action gets a normal approval card.</p>
              <strong>Start with the recommended rules</strong>
              <ul>
                <li>Block deletes and archives</li>
                <li>Merges and file changes on main and release branches need extra approval</li>
                <li>Comments run without approval</li>
              </ul>
              <button className="primary-button" disabled={!canChange || saving} onClick={() => void addStarter()}>
                Add recommended rules
              </button>
            </div>
          )}
        </section>
        <section className="memory-form approval-rule-form">
          <div className="section-heading">
            <h2>{selected ? selected.name : "New rule"}</h2>
          </div>
          <fieldset disabled={!canChange || saving}>
            <label>
              Name
              <input
                value={draft.name}
                maxLength={100}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Production merges need two approvers"
                aria-label="Rule name"
              />
            </label>
            <div className="approval-effect-options" role="radiogroup" aria-label="What the rule does">
              {EFFECTS.map((effect) => (
                <label key={effect.value} className={draft.effect === effect.value ? "active" : ""}>
                  <input
                    type="radio"
                    name="effect"
                    value={effect.value}
                    checked={draft.effect === effect.value}
                    onChange={() => setDraft({ ...draft, effect: effect.value })}
                  />
                  <strong>{effect.label}</strong>
                  <span>{effect.help}</span>
                </label>
              ))}
            </div>
            {draft.effect === "require_approvals" && (
              <label>
                Approvals needed
                <select
                  value={draft.requiredApprovals}
                  onChange={(event) => setDraft({ ...draft, requiredApprovals: Number(event.target.value) })}
                  aria-label="Approvals needed"
                >
                  {[1, 2, 3, 4, 5].map((count) => (
                    <option key={count} value={count}>
                      {count} {count === 1 ? "person" : "people"} other than the requester
                    </option>
                  ))}
                </select>
                {capacityWarning(draft.requiredApprovals, approvers) && (
                  <span className="approval-rule-warning" role="note">
                    {capacityWarning(draft.requiredApprovals, approvers)}
                  </span>
                )}
              </label>
            )}
            <label>
              Tool
              <select
                value={draft.provider}
                onChange={(event) => setDraft({ ...draft, provider: event.target.value as Draft["provider"] })}
                aria-label="Tool"
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.value} value={provider.value}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="approval-category-field">
              <span>
                Action types <span className="optional-marker">None selected means any</span>
              </span>
              <div className="approval-category-options">
                {CATEGORIES.map((category) => (
                  <label key={category.value} className={draft.categories.includes(category.value) ? "active" : ""}>
                    <input
                      type="checkbox"
                      checked={draft.categories.includes(category.value)}
                      onChange={() => toggleCategory(category.value)}
                    />
                    {category.label}
                  </label>
                ))}
              </div>
            </div>
            {showGithubFields && (
              <div className="memory-two-columns">
                <label>
                  Repository <span className="optional-marker">Optional</span>
                  <input
                    value={draft.repoPattern}
                    onChange={(event) => setDraft({ ...draft, repoPattern: event.target.value })}
                    placeholder="acme/web, acme/*"
                    aria-label="Repository pattern"
                  />
                </label>
                <label>
                  Branch <span className="optional-marker">Optional</span>
                  <input
                    value={draft.branchPattern}
                    onChange={(event) => setDraft({ ...draft, branchPattern: event.target.value })}
                    placeholder="main, release/*"
                    aria-label="Branch pattern"
                  />
                </label>
              </div>
            )}
            {showSlackFields && (
              <label>
                Slack channel <span className="optional-marker">Optional</span>
                <input
                  value={draft.channelPattern}
                  onChange={(event) => setDraft({ ...draft, channelPattern: event.target.value })}
                  placeholder="announcements, eng-*"
                  aria-label="Slack channel pattern"
                />
              </label>
            )}
            <small className="field-help">
              Separate several values with commas. <code>*</code> matches anything, so <code>release/*</code> covers
              every release branch. For a pull request, the branch is the one it merges into.
            </small>
            <label className="approval-rule-enabled">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              Rule is on
            </label>
          </fieldset>
          <p className="approval-rule-summary" data-testid="approval-rule-summary">
            {summarizeRule(toInput(draft))}
          </p>
          <div className="memory-builder-footer">
            <button className="primary-button" disabled={!canChange || saving} onClick={() => void save()}>
              {saving ? "Saving…" : selected ? "Save changes" : "Create rule"}
            </button>
            {selected && (
              <button className="agent-delete-button" disabled={!canChange || saving} onClick={() => void remove()}>
                Delete
              </button>
            )}
          </div>
          {selected && (
            <p className="memory-meta">
              Created by {selected.createdByName ?? "a former member"} · updated{" "}
              {new Date(selected.updatedAt).toLocaleString()}
            </p>
          )}
          {!access.loading && !canChange && (
            <p className="muted" role="note">
              Only Admins can change approval rules. You can see every rule that applies to this workspace.
            </p>
          )}
          {error && <p className="error-text">{error}</p>}
          {notice && <p className="success-text">{notice}</p>}
        </section>
      </div>
      <section className="standing-approvals" aria-label="Standing approvals" data-testid="standing-approvals">
        <h2>Standing approvals</h2>
        <p>
          Given from an approval card with &ldquo;Also approve similar actions for 7 days&rdquo;. They apply only where
          no rule asks for more than a normal approval card.
        </p>
        {standing.length ? (
          standing.map((approval) => (
            <div className="standing-approval-row" key={approval.id} data-testid="standing-approval-row">
              <div>
                <strong>{approval.description}</strong>
                <small>
                  By {approval.createdByName} · until {new Date(approval.expiresAt).toLocaleDateString()}
                </small>
              </div>
              <button
                className="secondary-button"
                disabled={!(access.isAdmin || approval.createdByUserId === user?.id)}
                onClick={() => void revoke(approval)}
              >
                Revoke
              </button>
            </div>
          ))
        ) : (
          <p className="muted">None right now.</p>
        )}
      </section>
    </main>
  );
}
