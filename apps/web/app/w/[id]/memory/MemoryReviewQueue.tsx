"use client";

import { useState } from "react";
import type { WorkspaceMemoryProposal } from "@mai-chat/shared-types";
import { describeError, reviewMemoryProposal, withdrawMemoryProposal } from "../../../../lib/api";
import { useDialog } from "../../../_components/DialogProvider";

const ACTION_LABELS = { create: "New entry", update: "Edit", delete: "Delete" } as const;
const STATUS_LABELS = {
  pending: "Waiting for review",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
} as const;

function day(value: string | null): string {
  return value ? value.slice(0, 10) : "None";
}

// Field-by-field comparison so a reviewer sees exactly what would reach every
// agent: unchanged fields are hidden for edits, everything is shown for new
// entries and deletions.
function ProposalFields({ proposal }: { proposal: WorkspaceMemoryProposal }) {
  const current = proposal.current;
  const rows: Array<[string, string, string]> = [
    ["Type", current?.kind ?? "", proposal.kind],
    ["Title", current?.title ?? "", proposal.title],
    ["Content", current?.content ?? "", proposal.content],
    [
      "Source",
      current ? [current.sourceTitle, current.sourceUrl].filter(Boolean).join(" · ") : "",
      [proposal.sourceTitle, proposal.sourceUrl].filter(Boolean).join(" · "),
    ],
    ["Review by", current ? day(current.freshUntil) : "", day(proposal.freshUntil)],
  ];
  if (proposal.action === "update") {
    const changed = rows.filter(([, before, after]) => before !== after);
    if (!changed.length) return <p className="muted">No visible change from the current version.</p>;
    return (
      <dl className="memory-proposal-diff">
        {changed.map(([label, before, after]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <del>{before || "—"}</del>
              <ins>{after || "—"}</ins>
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={`memory-proposal-diff ${proposal.action === "delete" ? "removing" : ""}`}>
      {rows.map(([label, , value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function MemoryReviewQueue({
  workspaceId,
  isAdmin,
  proposals,
  onChanged,
}: {
  workspaceId: string;
  isAdmin: boolean;
  proposals: WorkspaceMemoryProposal[];
  onChanged: (message: string) => void | Promise<void>;
}) {
  const dialog = useDialog();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const decided = proposals.filter((proposal) => proposal.status !== "pending").slice(0, isAdmin ? 0 : 5);
  if (!pending.length && !decided.length) return null;

  async function act(proposal: WorkspaceMemoryProposal, decision: "approve" | "reject" | "withdraw") {
    setError("");
    let note: string | undefined;
    if (decision === "reject") {
      const answer = await dialog.prompt({
        title: `Reject the change to ${proposal.title}?`,
        message: "The proposer is notified with your note.",
        label: "Note",
        placeholder: "e.g. This decision was reversed last week",
        confirmLabel: "Reject change",
        maxLength: 500,
      });
      if (answer === null) return;
      note = answer.trim() || undefined;
    }
    setBusy(proposal.id);
    try {
      if (decision === "withdraw") await withdrawMemoryProposal(workspaceId, proposal.id);
      else await reviewMemoryProposal(workspaceId, proposal.id, decision, note);
      await onChanged(
        decision === "approve"
          ? "Change approved. Agents use it from the next reply."
          : decision === "reject"
            ? "Change rejected."
            : "Proposal withdrawn.",
      );
    } catch (err) {
      setError(describeError(err, "Could not update this proposal."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="memory-review-queue" aria-label="Memory changes waiting for review">
      <div className="section-heading">
        <h2>{isAdmin ? "Changes to review" : "Your proposed changes"}</h2>
        {pending.length > 0 && <span className="memory-review-count">{pending.length} waiting</span>}
      </div>
      <p className="muted">
        {isAdmin
          ? "Memory is read by every agent, so changes from other members wait for an Admin. Approve only what you would want every agent to follow."
          : "An Admin reviews memory changes before agents can use them. Agents keep using the current version until then."}
      </p>
      {[...pending, ...decided].map((proposal) => (
        <article key={proposal.id} className={`memory-proposal ${proposal.status}`}>
          <header>
            <span className={`memory-proposal-action ${proposal.action}`}>{ACTION_LABELS[proposal.action]}</span>
            <strong>{proposal.title}</strong>
            <small>
              {proposal.proposedByName ?? "A former member"} · {new Date(proposal.createdAt).toLocaleString()}
              {proposal.status !== "pending" && ` · ${STATUS_LABELS[proposal.status]}`}
              {proposal.reviewedByName && ` by ${proposal.reviewedByName}`}
            </small>
          </header>
          {proposal.status === "pending" && <ProposalFields proposal={proposal} />}
          {proposal.reviewNote && <p className="memory-proposal-note">Note: {proposal.reviewNote}</p>}
          {proposal.outdated && (
            <p className="memory-proposal-outdated" role="note">
              The entry changed after this was proposed, so it can no longer be approved.
            </p>
          )}
          {proposal.status === "pending" && (
            <div className="memory-proposal-actions">
              {isAdmin ? (
                <>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy === proposal.id || proposal.outdated}
                    onClick={() => void act(proposal, "approve")}
                  >
                    {proposal.action === "delete" ? "Approve deletion" : "Approve"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy === proposal.id}
                    onClick={() => void act(proposal, "reject")}
                  >
                    Reject
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy === proposal.id}
                  onClick={() => void act(proposal, "withdraw")}
                >
                  Withdraw
                </button>
              )}
            </div>
          )}
        </article>
      ))}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
