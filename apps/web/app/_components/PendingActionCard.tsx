"use client";

import { useState, type ReactNode } from "react";
import type { PendingAction } from "@mai-chat/shared-types";
import { ApiError, describeError, confirmAction, cancelAction } from "../../lib/api";
import { ChangePreviewView, ProposalContextView } from "./ChangePreviewView";

// One card per PendingAction the agent has queued but not yet run (see
// services/chat-server/src/actions.ts). Only renders for status "pending"
// -- the parent page filters that -- since a resolved action's outcome is
// already visible as a System chat message.
export default function PendingActionCard({
  workspaceId,
  action,
  actorName,
  currentUserId,
  canApprove = true,
  onRequestAccess,
}: {
  workspaceId: string;
  action: PendingAction;
  actorName: string;
  // The signed-in member, so the card never offers "Run as me" for an
  // action that already runs as them.
  currentUserId?: string;
  // External approvals: Admins by default, Editors with approveActions.
  canApprove?: boolean;
  onRequestAccess?: ReactNode;
}) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | "runAsMe" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the server reports the run-as connection is gone and the
  // approver's own connection can do it instead.
  const runsAsCurrentUser = !!currentUserId && action.runAsUserId === currentUserId;
  const [offerRunAsMe, setOfferRunAsMe] = useState(action.runAsAvailable === false && !runsAsCurrentUser);
  // GitHub writes target owner/repo. Slack's MCP tools pass channel_id,
  // older Slack tools passed channel, and Figma tools pass the file link.
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const channel = text(action.args.channel) ?? text(action.args.channel_id);
  const target =
    action.target?.label ||
    [action.args.owner, action.args.repo]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("/") ||
    (channel ? `#${channel.replace(/^#/, "")}` : null) ||
    text(action.args.file) ||
    action.toolName;
  const warnings = action.warnings ?? [];
  const runsAs = `${action.runAsName ?? action.requestedByName ?? "The requester"}${
    action.runAsAccount
      ? ` (${action.agentKind === "github" || !action.agentKind ? "@" : ""}${action.runAsAccount})`
      : ""
  }`;

  // Approval rules: an action a rule governs needs approvals from people
  // other than the requester, possibly more than one.
  const ruleName = action.approvalRuleName ?? null;
  const requiredApprovals = Math.max(1, action.requiredApprovals ?? 1);
  const approvals = action.approvals ?? [];
  const ruleGoverned = Boolean(ruleName);
  const isRequester = !!currentUserId && action.requestedByUserId === currentUserId;
  const alreadyApproved = !!currentUserId && approvals.some((approval) => approval.userId === currentUserId);
  const blockedForMe = ruleGoverned && (isRequester || alreadyApproved);
  const finalApproval = approvals.length + 1 >= requiredApprovals;
  // Who the action runs as only matters for the approval that completes the
  // set, so earlier approvers always get a plain Approve button.
  const showRunAsMe = offerRunAsMe && !blockedForMe && (!ruleGoverned || finalApproval);
  // "Also approve similar actions for 7 days": only where no rule asks for
  // more than a normal card, and never for workflows that require approval.
  const canRemember = canApprove && !ruleGoverned && action.autoApproveAllowed !== false;
  const [remember, setRemember] = useState(false);
  const providerLabel: Record<string, string> = {
    github: "GitHub",
    slack: "Slack",
    linear: "Linear",
    notion: "Notion",
    figma: "Figma",
  };
  const provider = action.target?.provider ?? action.agentKind ?? "github";
  const scopeLabel =
    (provider === "github" && action.target?.repo) ||
    (provider === "slack" && action.target?.channel && action.target.channel !== "unknown"
      ? `#${(action.target.channelName ?? action.target.channel).replace(/^#/, "")}`
      : null) ||
    providerLabel[provider] ||
    provider;
  const protection = action.target?.branchProtection;
  const expiresIn = action.expiresAt ? Date.parse(action.expiresAt) - Date.now() : null;
  const expiresLabel =
    expiresIn === null
      ? null
      : expiresIn <= 0
        ? "Expired"
        : expiresIn < 3_600_000
          ? `Expires in ${Math.max(1, Math.round(expiresIn / 60_000))} min`
          : `Expires in ${Math.round(expiresIn / 3_600_000)} h`;

  async function handle(intent: "confirm" | "cancel" | "runAsMe") {
    setBusy(intent);
    setError(null);
    try {
      if (intent === "cancel") await cancelAction(workspaceId, action.id, actorName);
      else
        await confirmAction(workspaceId, action.id, actorName, {
          ...(intent === "runAsMe" ? { runAs: "me" as const } : {}),
          ...(remember && canRemember ? { remember: true } : {}),
        });
      // An approval that doesn't complete the set leaves the card in place
      // (updated over the WebSocket), so the buttons need to work again.
      setBusy(null);
      // No local state update needed on success -- the server broadcasts
      // a pending_action_update over the WebSocket, which is what
      // actually removes this card (via the parent's status === "pending"
      // filter) for everyone in the room, including this tab.
    } catch (err) {
      if (err instanceof ApiError && err.code === "run_as_unavailable" && !runsAsCurrentUser) setOfferRunAsMe(true);
      setError(describeError(err, "Something went wrong."));
      setBusy(null);
    }
  }

  return (
    <div className="pending-action" data-testid="pending-action-card">
      <div className="pending-action-header">
        <div className="pending-action-label">Approval required</div>
        <span>
          Nothing has changed yet
          {expiresLabel && <span data-testid="pending-action-expires"> · {expiresLabel}</span>}
        </span>
      </div>
      <div className="pending-action-desc">{action.description}</div>
      <dl className="pending-action-details">
        <div>
          <dt>Action</dt>
          <dd>{action.toolName.replace(/[_-]/g, " ")}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{target}</dd>
        </div>
        <div>
          <dt>Requested by</dt>
          <dd>{action.requestedByName ?? "A workspace member"}</dd>
        </div>
        <div>
          <dt>Runs as</dt>
          <dd data-testid="pending-action-runs-as">
            {runsAs}
            {action.runAsAvailable === false && (
              <span className="pending-action-unavailable" title="This connection is no longer available">
                {" "}
                · unavailable
              </span>
            )}
          </dd>
        </div>
      </dl>
      {ruleGoverned && (
        <div className="pending-action-rule" role="note" data-testid="pending-action-rule">
          <strong>Approval rule</strong>
          {ruleName} · {approvals.length} of {requiredApprovals} approval{requiredApprovals === 1 ? "" : "s"}
          {approvals.length > 0 && <> · approved by {approvals.map((approval) => approval.name).join(", ")}</>}
        </div>
      )}
      {protection?.protected && (
        <div className="pending-action-rule pending-action-github" role="note" data-testid="pending-action-github">
          <strong>GitHub also checks this</strong>
          {protection.branch} is a protected branch
          {protection.requiredReviews
            ? `: pull requests into it need ${protection.requiredReviews} approving review${protection.requiredReviews === 1 ? "" : "s"} on GitHub.`
            : "."}
          {action.target?.kind === "file" && " A direct change there may be rejected; a pull request is safer."}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="pending-action-warnings" role="note" data-testid="pending-action-warnings">
          <strong>Possible duplicate{warnings.length === 1 ? "" : "s"}</strong>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning.kind}-${index}`}>
                {warning.message}
                {warning.url && (
                  <>
                    {" "}
                    <a href={warning.url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {action.changePreview?.sections.length ? (
        <ChangePreviewView preview={action.changePreview} />
      ) : (
        action.preview && <pre className="pending-action-preview">{action.preview}</pre>
      )}
      {action.proposalContext && <ProposalContextView context={action.proposalContext} />}
      {error && <div className="pending-action-error">{error}</div>}
      <p className="pending-action-note">
        {!canApprove
          ? "An Admin or a teammate with the “Approve actions” permission must confirm this action."
          : isRequester && ruleGoverned
            ? `You asked for this action, so under the rule “${ruleName}” someone else has to approve it.`
            : alreadyApproved
              ? `You approved this. Waiting for ${requiredApprovals - approvals.length} more approval${requiredApprovals - approvals.length === 1 ? "" : "s"} from someone else.`
              : showRunAsMe
                ? `${action.runAsName ?? action.requestedByName ?? "The requester"}'s connection can no longer run this. You can run it with your own account instead.`
                : runsAsCurrentUser && action.runAsAvailable === false
                  ? "Your connection for this tool is no longer available. Reconnect it under Integrations before confirming, or cancel."
                  : warnings.length
                    ? "Check the possible duplicates above before approving."
                    : "Review the target and preview, then approve to run this action."}
      </p>
      {canRemember && !showRunAsMe && (
        <label className="pending-action-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            data-testid="remember-approval"
          />
          Also approve similar actions for 7 days ({action.toolName.replace(/[_-]+/g, " ")} on {scopeLabel})
        </label>
      )}
      {!canApprove && onRequestAccess}
      <div className="pending-action-buttons">
        {showRunAsMe && canApprove ? (
          <button
            className="btn"
            disabled={busy !== null || blockedForMe}
            onClick={() => handle("runAsMe")}
            data-testid="run-as-me-btn"
          >
            {busy === "runAsMe" ? "Running…" : "Run as me"}
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy !== null || !canApprove || blockedForMe}
            onClick={() => handle("confirm")}
            data-testid="confirm-action-btn"
          >
            {busy === "confirm"
              ? "Confirming…"
              : ruleGoverned && !finalApproval
                ? `Approve (${approvals.length + 1} of ${requiredApprovals})`
                : warnings.length
                  ? "Confirm anyway"
                  : "Confirm"}
          </button>
        )}
        <button
          className="btn secondary"
          disabled={busy !== null || !canApprove}
          onClick={() => handle("cancel")}
          data-testid="cancel-action-btn"
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
