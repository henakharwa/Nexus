"use client";

import Link from "next/link";
import { useDialog } from "../../../_components/DialogProvider";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { WorkspaceMemory, WorkspaceMemoryProposal } from "@mai-chat/shared-types";
import {
  describeError,
  createWorkspaceMemory,
  deleteWorkspaceMemory,
  listMemoryProposals,
  listWorkspaceMemory,
  updateWorkspaceMemory,
  type WorkspaceMemoryInput,
} from "../../../../lib/api";
import { MemoryReviewQueue } from "./MemoryReviewQueue";
import { missingRequiredFields } from "../../../../lib/builder-validation";
import { AccessNotice } from "../../../_components/AccessNotice";
import { useWorkspaceAccess } from "../../../../lib/useWorkspaceAccess";

const blank: WorkspaceMemoryInput = {
  kind: "knowledge",
  title: "",
  content: "",
  sourceTitle: "",
  sourceUrl: "",
  freshUntil: "",
};
type BuilderStep = "entry" | "source" | "review";
function dateInput(value: string | null) {
  return value ? value.slice(0, 10) : "";
}
function stale(memory: WorkspaceMemory) {
  return Boolean(memory.freshUntil && new Date(memory.freshUntil).getTime() < Date.now());
}
function formatDate(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
    : "No review date";
}

export default function MemoryPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const [memories, setMemories] = useState<WorkspaceMemory[]>([]);
  const [selected, setSelected] = useState<WorkspaceMemory | null>(null);
  const [draft, setDraft] = useState<WorkspaceMemoryInput>(blank);
  const [filter, setFilter] = useState<"all" | "knowledge" | "decision">("all");
  const [builderStep, setBuilderStep] = useState<BuilderStep>("entry");
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const dialog = useDialog();
  const access = useWorkspaceAccess(workspaceId);
  const canChange = access.can("manageMemory");
  // Only Admins change memory directly; other members' changes are reviewed.
  const reviewed = !access.isAdmin;
  const [proposals, setProposals] = useState<WorkspaceMemoryProposal[]>([]);
  const refreshProposals = async () => setProposals(await listMemoryProposals(workspaceId));
  const refresh = async () => {
    const [entries] = await Promise.all([listWorkspaceMemory(workspaceId), refreshProposals().catch(() => undefined)]);
    setMemories(entries);
  };
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void refresh()
      .catch((err: unknown) => setError(describeError(err, "Could not load memory.")))
      .finally(() => setLoading(false));
  }, [workspaceId]);
  const pendingFor = (memoryId: string) =>
    proposals.some((proposal) => proposal.status === "pending" && proposal.memoryId === memoryId);
  function edit(memory: WorkspaceMemory) {
    setSelected(memory);
    setBuilderStep("entry");
    setStepErrors({});
    setDraft({
      kind: memory.kind,
      title: memory.title,
      content: memory.content,
      sourceTitle: memory.sourceTitle ?? "",
      sourceUrl: memory.sourceUrl ?? "",
      freshUntil: dateInput(memory.freshUntil),
    });
    setError("");
    setNotice("");
  }
  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = selected
        ? await updateWorkspaceMemory(workspaceId, selected.id, draft)
        : await createWorkspaceMemory(workspaceId, draft);
      await refresh();
      if (!result.applied) {
        if (!selected) setDraft(blank);
        setNotice("Sent to an Admin for review. Agents keep using the current memory until it is approved.");
        return;
      }
      if (result.memory) edit(result.memory);
      setNotice(selected ? "Memory updated." : "Memory saved for the workspace.");
    } catch (err) {
      setError(describeError(err, "Could not save memory."));
    } finally {
      setSaving(false);
    }
  }
  const clearStepError = (field: string) =>
    setStepErrors((current) => {
      const remaining = { ...current };
      delete remaining[field];
      return remaining;
    });
  const validateEntry = () => {
    const errors: Record<string, string> = {};
    const missing = missingRequiredFields({ title: draft.title, content: draft.content });
    if (missing.includes("title")) errors.title = "Enter a title before continuing.";
    if (missing.includes("content")) errors.content = "Add the memory content before continuing.";
    setStepErrors(errors);
    return Object.keys(errors).length === 0;
  };
  const moveToStep = (step: BuilderStep) => {
    if (step !== "entry" && !validateEntry()) {
      setBuilderStep("entry");
      return;
    }
    setBuilderStep(step);
  };
  async function remove() {
    if (
      !selected ||
      !(await dialog.confirm({
        title: reviewed ? `Ask to delete ${selected.title}?` : `Delete ${selected.title}?`,
        message: reviewed
          ? "An Admin reviews the request. The entry stays available to agents until it is approved."
          : "This removes it from future agent context. This cannot be undone.",
        confirmLabel: reviewed ? "Request deletion" : "Delete memory",
        danger: true,
      }))
    )
      return;
    setSaving(true);
    try {
      const result = await deleteWorkspaceMemory(workspaceId, selected.id);
      await refresh();
      if (!result.applied) {
        setNotice("Deletion sent to an Admin for review.");
        return;
      }
      setSelected(null);
      setDraft(blank);
    } catch (err) {
      setError(describeError(err, "Could not delete memory."));
    } finally {
      setSaving(false);
    }
  }
  const visible = memories.filter((memory) => filter === "all" || memory.kind === filter);
  return (
    <main className="workspace-settings-page memory-page">
      <header>
        <p className="eyebrow">WORKSPACE MEMORY</p>
        <h1>Keep the context that matters</h1>
        <p>
          Save shared knowledge and decisions with citations and review dates. Current entries are available to every
          workspace agent{reviewed ? ", so an Admin approves changes before agents use them" : ""}.
        </p>
      </header>
      <MemoryReviewQueue
        workspaceId={workspaceId}
        isAdmin={access.isAdmin}
        proposals={proposals}
        onChanged={async (message) => {
          setNotice(message);
          setError("");
          await refresh();
        }}
      />
      <div className="memory-layout">
        <section className="memory-list">
          <div className="section-heading">
            <h2>Memory</h2>
            <button
              disabled={!canChange}
              onClick={() => {
                setSelected(null);
                setDraft(blank);
                setError("");
                setNotice("");
              }}
            >
              New entry
            </button>
          </div>
          <div className="memory-filter">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
              All
            </button>
            <button className={filter === "knowledge" ? "active" : ""} onClick={() => setFilter("knowledge")}>
              Knowledge
            </button>
            <button className={filter === "decision" ? "active" : ""} onClick={() => setFilter("decision")}>
              Decisions
            </button>
          </div>
          {visible.length ? (
            visible.map((memory) => (
              <button
                key={memory.id}
                className={`memory-card ${selected?.id === memory.id ? "selected" : ""}`}
                onClick={() => edit(memory)}
              >
                <span className={`memory-kind ${memory.kind}`}>{memory.kind}</span>
                <strong>{memory.title}</strong>
                <small>
                  {stale(memory) ? "Needs review" : formatDate(memory.freshUntil)}
                  {pendingFor(memory.id) ? " · Change pending" : ""}
                </small>
              </button>
            ))
          ) : loading ? (
            <div className="list-loading" role="status" aria-label="Loading memory">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <p className="muted">No saved {filter === "all" ? "memory" : filter} yet.</p>
          )}
        </section>
        <section className="memory-form">
          <div className="section-heading">
            <h2>{selected ? selected.title : "New memory"}</h2>
            {selected && (
              <span className={`memory-review ${stale(selected) ? "stale" : "current"}`}>
                {stale(selected) ? "Needs review" : selected.freshUntil ? "Current" : "No review date"}
              </span>
            )}
          </div>
          <section className="memory-builder-steps">
            {(
              [
                ["entry", "Memory"],
                ["source", "Source"],
                ["review", "Review"],
              ] as const
            ).map(([step, label], index) => (
              <button
                type="button"
                key={step}
                className={builderStep === step ? "active" : ""}
                onClick={() => moveToStep(step)}
              >
                <span>{index + 1}</span>
                {label}
              </button>
            ))}
          </section>
          <section className="memory-builder-stage">
            {builderStep === "entry" && (
              <>
                <p>STEP 1 · MEMORY</p>
                <h3>Capture durable context</h3>
                <small>Save a decision or knowledge the entire workspace can rely on.</small>
                {Object.keys(stepErrors).length > 0 && (
                  <p className="builder-validation-summary" role="alert">
                    Please complete the required fields before continuing.
                  </p>
                )}
                <label>
                  Type <span className="required-marker">Required</span>
                  <select
                    value={draft.kind}
                    onChange={(e) => setDraft({ ...draft, kind: e.target.value as WorkspaceMemoryInput["kind"] })}
                  >
                    <option value="knowledge">Knowledge</option>
                    <option value="decision">Saved decision</option>
                  </select>
                </label>
                <label>
                  Title <span className="required-marker">Required</span>
                  <input
                    value={draft.title}
                    onChange={(e) => {
                      setDraft({ ...draft, title: e.target.value });
                      clearStepError("title");
                    }}
                    placeholder={
                      draft.kind === "decision" ? "Use release branch main" : "Production deployment process"
                    }
                    aria-invalid={Boolean(stepErrors.title)}
                    className={stepErrors.title ? "input-invalid" : ""}
                  />
                  {stepErrors.title && <span className="field-validation-error">{stepErrors.title}</span>}
                </label>
                <label>
                  {draft.kind === "decision" ? "Decision and rationale" : "What the team should know"}{" "}
                  <span className="required-marker">Required</span>
                  <textarea
                    rows={8}
                    value={draft.content}
                    onChange={(e) => {
                      setDraft({ ...draft, content: e.target.value });
                      clearStepError("content");
                    }}
                    placeholder="Write the durable context an agent and teammate can rely on."
                    aria-invalid={Boolean(stepErrors.content)}
                    className={stepErrors.content ? "input-invalid" : ""}
                  />
                  {stepErrors.content && <span className="field-validation-error">{stepErrors.content}</span>}
                </label>
              </>
            )}
            {builderStep === "source" && (
              <>
                <p>STEP 2 · SOURCE AND FRESHNESS</p>
                <h3>Cite and maintain this memory</h3>
                <small>Sources improve trust. A review date tells agents when to verify the information.</small>
                <div className="memory-two-columns">
                  <label>
                    Source title <span className="optional-marker">Optional</span>
                    <input
                      value={draft.sourceTitle ?? ""}
                      onChange={(e) => setDraft({ ...draft, sourceTitle: e.target.value })}
                      placeholder="Release plan"
                    />
                  </label>
                  <label>
                    Source URL <span className="optional-marker">Optional</span>
                    <input
                      type="url"
                      value={draft.sourceUrl ?? ""}
                      onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })}
                      placeholder="https://..."
                    />
                  </label>
                </div>
                <label>
                  Review by <span className="optional-marker">Optional</span>
                  <input
                    type="date"
                    value={draft.freshUntil ?? ""}
                    onChange={(e) => setDraft({ ...draft, freshUntil: e.target.value || null })}
                  />
                  <small className="field-help">Past this date, agents are instructed to verify the entry.</small>
                </label>
              </>
            )}
            {builderStep === "review" && (
              <>
                <p>STEP 3 · REVIEW</p>
                <h3>Ready to save?</h3>
                <small>Review the memory before making it available to every workspace agent.</small>
                <dl className="memory-review-summary">
                  <div>
                    <dt>Type</dt>
                    <dd>{draft.kind}</dd>
                  </div>
                  <div>
                    <dt>Title</dt>
                    <dd>{draft.title || "Untitled memory"}</dd>
                  </div>
                  <div>
                    <dt>Content</dt>
                    <dd>{draft.content || "No content added"}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{draft.sourceTitle || "No source cited"}</dd>
                  </div>
                  <div>
                    <dt>Review</dt>
                    <dd>{draft.freshUntil || "No review date"}</dd>
                  </div>
                </dl>
              </>
            )}
          </section>
          <div className="memory-builder-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={builderStep === "entry"}
              onClick={() =>
                setBuilderStep(({ entry: "entry", source: "entry", review: "source" } as const)[builderStep])
              }
            >
              Back
            </button>
            {builderStep !== "review" ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  if (!validateEntry()) return;
                  setBuilderStep(({ entry: "source", source: "review", review: "review" } as const)[builderStep]);
                }}
              >
                Continue
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={saving || !canChange || !draft.title.trim() || !draft.content.trim()}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : reviewed ? "Submit for review" : selected ? "Save changes" : "Save memory"}
              </button>
            )}
            {selected && (
              <button className="agent-delete-button" disabled={saving || !canChange} onClick={() => void remove()}>
                {reviewed ? "Request deletion" : "Delete"}
              </button>
            )}
          </div>
          {selected && (
            <p className="memory-meta">
              Saved by {selected.createdByName ?? "a former member"} · updated{" "}
              {new Date(selected.updatedAt).toLocaleString()}
            </p>
          )}
          {error && <p className="error-text">{error}</p>}
          {notice && <p className="success-text">{notice}</p>}
          <AccessNotice
            workspaceId={workspaceId}
            access={access}
            permission="manageMemory"
            message="Creating, editing, or deleting workspace memory requires the “Manage workspace memory” permission. You can still read saved memory."
          />
          {selected?.sourceUrl && (
            <a className="memory-source-link" href={selected.sourceUrl} target="_blank" rel="noreferrer">
              Open cited source ↗
            </a>
          )}
        </section>
      </div>
    </main>
  );
}
