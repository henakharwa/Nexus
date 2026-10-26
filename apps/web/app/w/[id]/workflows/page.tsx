"use client";

import Link from "next/link";
import { useDialog } from "../../../_components/DialogProvider";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type {
  Conversation,
  WorkspaceAgent,
  WorkspaceWorkflow,
  WorkflowRun,
  WorkflowTrigger,
} from "@mai-chat/shared-types";
import { AccessNotice } from "../../../_components/AccessNotice";
import { useWorkspaceUser } from "../../../_components/WorkspaceAuth";
import { useWorkspaceAccess } from "../../../../lib/useWorkspaceAccess";
import { missingRequiredFields } from "../../../../lib/builder-validation";
import {
  describeError,
  createWorkspaceWorkflow,
  deleteWorkspaceWorkflow,
  listConversations,
  listWorkflowRuns,
  listWorkspaceAgents,
  listWorkspaceWorkflows,
  runWorkspaceWorkflow,
  takeOverWorkflow,
  updateWorkspaceWorkflow,
  type WorkflowInput,
} from "../../../../lib/api";

const triggers: Array<{ value: WorkflowTrigger; label: string; help: string }> = [
  { value: "manual", label: "Manual", help: "Run when a teammate starts it." },
  { value: "schedule", label: "Schedule", help: "Run on a repeating interval." },
  {
    value: "github_issue",
    label: "New GitHub issue",
    help: "Runs when an issue is opened in a workspace repository. Connect GitHub events under Integrations.",
  },
  {
    value: "github_status",
    label: "GitHub status change",
    help: "Runs when a CI run or commit status finishes in a workspace repository. Connect GitHub events under Integrations.",
  },
  { value: "slack_mention", label: "Slack mention", help: "Run when the workspace is mentioned in Slack." },
];
const agentKinds = ["project", "github", "slack", "linear", "notion", "figma"] as const;
type BuilderStep = "identity" | "execution" | "delivery" | "governance" | "review";
const empty: WorkflowInput = {
  name: "",
  description: "",
  instructions: "",
  agentKind: "project",
  workspaceAgentId: null,
  conversationId: null,
  trigger: "manual",
  scheduleMinutes: 60,
  enabled: true,
  requiresApproval: false,
};
const testEventDefaults: Record<Exclude<WorkflowTrigger, "manual" | "schedule">, string> = {
  github_issue:
    'A new issue was opened: "Release build fails on the verification step." Summarize the issue and identify the next owner.',
  github_status:
    "The latest CI workflow completed with a failure in the test-and-build job. Explain whether the team is blocked and list the next action.",
  slack_mention: "@Nexus Can you summarize the release risk from today's discussion and tell us the next step?",
};
const workflowTemplates: Array<{ label: string; detail: string; value: WorkflowInput }> = [
  {
    label: "Release readiness",
    detail: "Daily GitHub release review",
    value: {
      ...empty,
      name: "Release readiness update",
      description: "Summarize release risk and the next owner.",
      instructions:
        "Review the connected repository, recent workspace context, open release risks, and approvals. Post a concise release-readiness update with blockers, owners, and the next action.",
      agentKind: "github",
      trigger: "schedule",
      scheduleMinutes: 1440,
    },
  },
  {
    label: "Mention responder",
    detail: "Answer Slack mentions with context",
    value: {
      ...empty,
      name: "Slack mention response",
      description: "Respond to workspace mentions with a concise next step.",
      instructions:
        "Use relevant workspace memory and connected Slack context. Summarize the request, identify risk or decisions, and provide one concrete next step.",
      agentKind: "slack",
      trigger: "slack_mention",
    },
  },
  {
    label: "Issue triage",
    detail: "Assess new GitHub issues",
    value: {
      ...empty,
      name: "GitHub issue triage",
      description: "Classify a new issue and assign the next investigation.",
      instructions:
        "Read the incoming issue and relevant workspace context. Summarize impact, identify the likely owner, list missing information, and propose the next investigation step.",
      agentKind: "github",
      trigger: "github_issue",
    },
  },
];

function formatDate(value: string | null) {
  return value
    ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Not run yet";
}
function labelForTrigger(trigger: WorkflowTrigger) {
  return triggers.find((item) => item.value === trigger)?.label ?? trigger;
}

export default function WorkflowsPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const [workflows, setWorkflows] = useState<WorkspaceWorkflow[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<WorkspaceWorkflow | null>(null);
  const [draft, setDraft] = useState<WorkflowInput>(empty);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testEventText, setTestEventText] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "attention">("all");
  const [showTestLab, setShowTestLab] = useState(false);
  const [loading, setLoading] = useState(true);
  const [builderStep, setBuilderStep] = useState<BuilderStep>("identity");
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});

  const access = useWorkspaceAccess(workspaceId);
  const user = useWorkspaceUser();
  const dialog = useDialog();
  // Create, edit, delete, enable, schedule, and run: Admins by default,
  // Editors with the manageWorkflows permission. Viewing is shared.
  const canChange = access.can("manageWorkflows");
  // Server-side workflow changes are restricted further than the workspace
  // permission: an existing workflow can only be changed by its owner or an
  // Admin. Mirror that rule in the builder so an Editor never spends time
  // editing a draft that the server must reject on save. New workflows are
  // still available to Editors who have Manage workflows.
  const canEditSelectedWorkflow = !selected || access.isAdmin || selected.ownerUserId === user.id;
  const canModifyWorkflow = canChange && canEditSelectedWorkflow;
  const refresh = async () => setWorkflows(await listWorkspaceWorkflows(workspaceId));
  useEffect(() => {
    void Promise.all([
      refresh(),
      listWorkspaceAgents(workspaceId).then(setAgents),
      listConversations(workspaceId).then(setConversations),
    ])
      .catch((err: unknown) => setError(describeError(err, "Could not load workflows.")))
      .finally(() => setLoading(false));
  }, [workspaceId]);
  async function select(workflow: WorkspaceWorkflow) {
    setSelected(workflow);
    setBuilderStep("identity");
    setStepErrors({});
    setError("");
    setNotice("");
    // The checkpoint used to be stored as a sentence in the instructions; it is now a saved setting, so drop that legacy sentence from the editor.
    setDraft({
      name: workflow.name,
      description: workflow.description,
      instructions: workflow.instructions.replace(
        /\n*Approval checkpoint required before proposing an external change\./i,
        "",
      ),
      requiresApproval: workflow.requiresApproval,
      agentKind: workflow.agentKind,
      workspaceAgentId: workflow.workspaceAgentId,
      conversationId: workflow.conversationId,
      trigger: workflow.trigger,
      scheduleMinutes: workflow.scheduleMinutes ?? 60,
      enabled: workflow.enabled,
    });
    try {
      setRuns(await listWorkflowRuns(workspaceId, workflow.id));
    } catch {
      setRuns([]);
    }
  }
  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const workflow = selected
        ? await updateWorkspaceWorkflow(workspaceId, selected.id, draft)
        : await createWorkspaceWorkflow(workspaceId, draft);
      await refresh();
      await select(workflow);
      setNotice(selected ? "Workflow updated." : "Workflow created.");
    } catch (err) {
      setError(describeError(err, "Could not save workflow."));
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
  const validateRequiredFields = (throughStep: BuilderStep) => {
    const errors: Record<string, string> = {};
    const stepIndex = ["identity", "execution", "delivery", "governance", "review"].indexOf(throughStep);
    const missing = missingRequiredFields({ name: draft.name, instructions: draft.instructions });
    if (missing.includes("name")) errors.name = "Enter a workflow name before continuing.";
    if (stepIndex >= 1 && missing.includes("instructions")) errors.instructions = "Add instructions before continuing.";
    setStepErrors(errors);
    const firstInvalidStep: BuilderStep | null = errors.name ? "identity" : errors.instructions ? "execution" : null;
    return { valid: !firstInvalidStep, firstInvalidStep };
  };
  const moveToStep = (nextStep: BuilderStep) => {
    const nextIndex = ["identity", "execution", "delivery", "governance", "review"].indexOf(nextStep);
    if (nextIndex > 0) {
      const validation = validateRequiredFields(nextStep === "execution" ? "identity" : "execution");
      if (!validation.valid) {
        setBuilderStep(validation.firstInvalidStep!);
        return;
      }
    }
    setBuilderStep(nextStep);
  };
  const continueBuilder = () => {
    const validation = validateRequiredFields(builderStep);
    if (!validation.valid) {
      setBuilderStep(validation.firstInvalidStep!);
      return;
    }
    setBuilderStep(
      (
        {
          identity: "execution",
          execution: "delivery",
          delivery: "governance",
          governance: "review",
          review: "review",
        } as const
      )[builderStep],
    );
  };
  async function run(
    trigger: "manual" | "github_issue" | "github_status" | "slack_mention" = "manual",
    sampleEvent?: string,
  ) {
    if (!selected) return;
    setSaving(true);
    setError("");
    try {
      await runWorkspaceWorkflow(
        workspaceId,
        selected.id,
        trigger,
        sampleEvent?.trim() || (trigger === "manual" ? undefined : testEventText.trim() || testEventDefaults[trigger]),
      );
      setNotice("Workflow started. Its response will appear in the selected conversation.");
      setTimeout(() => {
        void listWorkflowRuns(workspaceId, selected.id).then(setRuns);
        void refresh();
      }, 800);
    } catch (err) {
      setError(describeError(err, "Could not run workflow."));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (
      !selected ||
      !(await dialog.confirm({
        title: `Delete ${selected.name}?`,
        message: "Its schedule and run history will be removed. This cannot be undone.",
        confirmLabel: "Delete workflow",
        danger: true,
      }))
    )
      return;
    setSaving(true);
    try {
      await deleteWorkspaceWorkflow(workspaceId, selected.id);
      setSelected(null);
      setDraft(empty);
      setStepErrors({});
      setRuns([]);
      await refresh();
    } catch (err) {
      setError(describeError(err, "Could not delete workflow."));
    } finally {
      setSaving(false);
    }
  }
  const publishedAgents = agents.filter((agent) => agent.status === "published");
  const triggerHelp = triggers.find((item) => item.value === draft.trigger)?.help;
  const visibleWorkflows = workflows.filter((workflow) => {
    const matchesText = `${workflow.name} ${workflow.description} ${workflow.trigger}`
      .toLowerCase()
      .includes(query.toLowerCase());
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && workflow.enabled) ||
      (statusFilter === "paused" && !workflow.enabled) ||
      (statusFilter === "attention" && workflow.lastRunStatus === "failed");
    return matchesText && matchesStatus;
  });
  const completedRuns = runs.filter((run) => run.status === "succeeded").length;
  const runSuccessRate = runs.length
    ? Math.round((completedRuns / runs.filter((run) => run.status !== "running").length || 0) * 100)
    : 0;
  const approvalRequired = Boolean(draft.requiresApproval);
  const previewContext = [
    "Workspace memory",
    draft.agentKind === "project"
      ? "Workspace context"
      : `${draft.agentKind[0].toUpperCase() + draft.agentKind.slice(1)} connection`,
    draft.conversationId ? "Selected conversation" : "Dedicated workflow conversation",
  ];
  return (
    <main className="workspace-settings-page workflow-page">
      <header>
        <p className="eyebrow">WORKFLOW AUTOMATION</p>
        <h1>Build reusable workflows</h1>
        <p>
          Turn recurring work into governed agent runs. Schedules and event triggers use the same connections,
          permissions, and approval steps as chat.
        </p>
      </header>
      <section className="workflow-command-center" aria-label="Workflow overview">
        <div>
          <span>ACTIVE AUTOMATION</span>
          <strong>{workflows.filter((workflow) => workflow.enabled).length}</strong>
          <small>workflows running</small>
        </div>
        <div>
          <span>RELIABILITY</span>
          <strong>
            {workflows.length
              ? `${Math.round(((workflows.length - workflows.filter((workflow) => workflow.lastRunStatus === "failed").length) / workflows.length) * 100)}%`
              : "—"}
          </strong>
          <small>latest run health</small>
        </div>
        <div>
          <span>NEXT RUN</span>
          <strong>
            {formatDate(
              workflows
                .filter((workflow) => workflow.nextRunAt)
                .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))[0]?.nextRunAt ?? null,
            )}
          </strong>
          <small>scheduled automation</small>
        </div>
        <div>
          <span>GOVERNANCE</span>
          <strong>{workflows.filter((workflow) => workflow.requiresApproval).length}</strong>
          <small>approval checkpoints</small>
        </div>
      </section>
      <section className="workflow-template-gallery">
        <div>
          <p className="eyebrow">START FASTER</p>
          <h2>Workflow templates</h2>
        </div>
        <div>
          {workflowTemplates.map((template, index) => (
            <button
              type="button"
              key={template.label}
              disabled={!canChange}
              className={`workflow-template-card template-${index}`}
              onClick={() => {
                setSelected(null);
                setDraft(template.value);
                setStepErrors({});
                setRuns([]);
                setNotice(`Loaded the ${template.label} template.`);
              }}
            >
              <span>{index === 0 ? "◒" : index === 1 ? "✦" : "↗"}</span>
              <strong>{template.label}</strong>
              <small>{template.detail}</small>
              <em>Use template →</em>
            </button>
          ))}
        </div>
      </section>
      <div className="workflow-layout">
        <section className="workflow-list">
          <div className="section-heading">
            <h2>Workflows</h2>
            <button
              disabled={!canChange}
              onClick={() => {
                setSelected(null);
                setDraft(empty);
                setStepErrors({});
                setRuns([]);
                setError("");
                setNotice("");
              }}
            >
              New workflow
            </button>
          </div>
          <div className="workflow-search">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search workflows"
              aria-label="Search workflows"
            />
            <div>
              {(["all", "active", "paused", "attention"] as const).map((filter) => (
                <button
                  type="button"
                  className={statusFilter === filter ? "active" : ""}
                  key={filter}
                  onClick={() => setStatusFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>
          {visibleWorkflows.length ? (
            visibleWorkflows.map((workflow) => (
              <button
                key={workflow.id}
                className={`workflow-card ${selected?.id === workflow.id ? "selected" : ""}`}
                onClick={() => void select(workflow)}
              >
                <span
                  className={`workflow-status ${workflow.enabled && workflow.ownerIsMember !== false ? "enabled" : "paused"}`}
                >
                  {workflow.ownerIsMember === false
                    ? "Owner left"
                    : workflow.lastRunStatus === "failed"
                      ? "Needs attention"
                      : workflow.enabled
                        ? "Active"
                        : "Paused"}
                </span>
                <strong>{workflow.name}</strong>
                <small>
                  {labelForTrigger(workflow.trigger)} ·{" "}
                  {workflow.nextRunAt ? `Next ${formatDate(workflow.nextRunAt)}` : formatDate(workflow.lastRunAt)}
                </small>
                <div className="workflow-card-icons">
                  <SpecialistIcon kind={workflow.agentKind} />
                  {workflow.workspaceAgentId && <span>AI</span>}
                </div>
              </button>
            ))
          ) : loading ? (
            <div className="list-loading" role="status" aria-label="Loading workflows">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <p className="muted">
              {workflows.length
                ? "No workflows match these filters."
                : "No workflows yet. Start from a template or create one."}
            </p>
          )}
        </section>
        <section className="workflow-form">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{selected ? "WORKFLOW DETAILS" : "NEW AUTOMATION"}</p>
              <h2>{selected ? selected.name : "New workflow"}</h2>
            </div>
            {selected && (
              <div className="workflow-heading-actions">
                <button
                  className="secondary-button workflow-run-button"
                  disabled={saving || !canModifyWorkflow}
                  onClick={() => void run()}
                >
                  Run now
                </button>
                <button type="button" className="secondary-button" onClick={() => setShowTestLab((value) => !value)}>
                  {showTestLab ? "Close test mode" : "Test mode"}
                </button>
              </div>
            )}
          </div>
          <section className="workflow-canvas" aria-label="Workflow execution path">
            <div className="workflow-node trigger">
              <span>TRIGGER</span>
              <strong>{labelForTrigger(draft.trigger)}</strong>
              <small>
                {draft.trigger === "schedule" ? `Every ${draft.scheduleMinutes ?? 60} minutes` : "Starts the run"}
              </small>
            </div>
            <i>→</i>
            <div className="workflow-node agent">
              <span>AGENT</span>
              <strong>
                {draft.workspaceAgentId
                  ? "Custom agent"
                  : `${draft.agentKind[0].toUpperCase() + draft.agentKind.slice(1)} specialist`}
              </strong>
              <small>Uses approved context</small>
            </div>
            <i>→</i>
            <div className={`workflow-node approval ${approvalRequired ? "required" : ""}`}>
              <span>APPROVAL</span>
              <strong>{approvalRequired ? "Checkpoint required" : "Governed automatically"}</strong>
              <small>{approvalRequired ? "Waits for review" : "External changes become proposals"}</small>
            </div>
            <i>→</i>
            <div className="workflow-node output">
              <span>OUTPUT</span>
              <strong>Workspace chat</strong>
              <small>{draft.conversationId ? "Selected conversation" : "Dedicated conversation"}</small>
            </div>
          </section>
          <section className="workflow-preview">
            <div>
              <p>INPUTS</p>
              <strong>What this run can use</strong>
              <span>
                {previewContext.map((item) => (
                  <em key={item}>{item}</em>
                ))}
              </span>
            </div>
            <div>
              <p>EXPECTED OUTPUT</p>
              <strong>{draft.description || "A concise team update"}</strong>
              <small>The run result is posted to the selected conversation and recorded in history.</small>
            </div>
          </section>
          <section className="workflow-builder-steps" aria-label="Workflow setup steps">
            {(
              [
                ["identity", "Identity"],
                ["execution", "Execution"],
                ["delivery", "Delivery"],
                ["governance", "Governance"],
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
          <section className="workflow-builder-stage">
            <fieldset className="access-readonly" disabled={!canModifyWorkflow}>
              {builderStep === "identity" && (
                <>
                  <p className="workflow-stage-kicker">STEP 1 · IDENTITY</p>
                  <h3>Name the recurring outcome</h3>
                  <small>Use a clear name and summary so teammates understand what this automation delivers.</small>
                  {stepErrors.name && (
                    <p className="builder-validation-summary" role="alert">
                      Please complete the required name before continuing.
                    </p>
                  )}
                  <label>
                    Name <span className="required-marker">Required</span>
                    <input
                      value={draft.name}
                      onChange={(e) => {
                        setDraft({ ...draft, name: e.target.value });
                        clearStepError("name");
                      }}
                      placeholder="Weekly release readiness"
                      autoFocus
                      aria-invalid={Boolean(stepErrors.name)}
                      className={stepErrors.name ? "input-invalid" : ""}
                    />
                    {stepErrors.name && <span className="field-validation-error">{stepErrors.name}</span>}
                  </label>
                  <label>
                    Description <span className="optional-marker">Optional</span>
                    <input
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      placeholder="A short description for your team"
                    />
                  </label>
                </>
              )}
              {builderStep === "execution" && (
                <>
                  <p className="workflow-stage-kicker">STEP 2 · EXECUTION</p>
                  <h3>Choose who does the work</h3>
                  <small>
                    Select a specialist or a published custom agent, then define the instructions for each run.
                  </small>
                  {stepErrors.instructions && (
                    <p className="builder-validation-summary" role="alert">
                      Please complete the required instructions before continuing.
                    </p>
                  )}
                  <label>
                    Instructions <span className="required-marker">Required</span>
                    <textarea
                      rows={7}
                      value={draft.instructions}
                      onChange={(e) => {
                        setDraft({ ...draft, instructions: e.target.value });
                        clearStepError("instructions");
                      }}
                      placeholder="Review open pull requests, checks, and release blockers. Share a concise update."
                      aria-invalid={Boolean(stepErrors.instructions)}
                      className={stepErrors.instructions ? "input-invalid" : ""}
                    />
                    {stepErrors.instructions && (
                      <span className="field-validation-error">{stepErrors.instructions}</span>
                    )}
                  </label>
                  <div className="workflow-two-columns">
                    <fieldset className="workflow-agent-picker">
                      <legend>Agent</legend>
                      <div role="radiogroup" aria-label="Workflow agent">
                        <button
                          type="button"
                          className={!draft.workspaceAgentId ? "selected" : ""}
                          onClick={() => setDraft({ ...draft, workspaceAgentId: null })}
                        >
                          <SpecialistIcon kind={draft.agentKind} />
                        </button>
                        {publishedAgents.map((agent) => (
                          <button
                            type="button"
                            key={agent.id}
                            className={draft.workspaceAgentId === agent.id ? "selected custom" : "custom"}
                            title={agent.name}
                            onClick={() =>
                              setDraft({ ...draft, workspaceAgentId: agent.id, agentKind: agent.baseAgent })
                            }
                          >
                            <CustomAgentIcon name={agent.name} />
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset className="workflow-specialist-picker">
                      <legend>Specialist</legend>
                      <div role="radiogroup">
                        {agentKinds.map((agent) => (
                          <button
                            type="button"
                            key={agent}
                            className={draft.agentKind === agent ? "selected" : ""}
                            disabled={Boolean(draft.workspaceAgentId)}
                            title={agent}
                            onClick={() => setDraft({ ...draft, agentKind: agent })}
                          >
                            <SpecialistIcon kind={agent} />
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                </>
              )}
              {builderStep === "delivery" && (
                <>
                  <p className="workflow-stage-kicker">STEP 3 · DELIVERY</p>
                  <h3>Set the trigger and destination</h3>
                  <small>Choose how the workflow starts and where its result is delivered.</small>
                  <label>
                    Post responses in
                    <select
                      value={draft.conversationId ?? ""}
                      onChange={(e) => setDraft({ ...draft, conversationId: e.target.value || null })}
                    >
                      <option value="">A dedicated workflow conversation</option>
                      {conversations.map((conversation) => (
                        <option key={conversation.id} value={conversation.id}>
                          {conversation.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset className="workflow-trigger-options">
                    <legend>Start this workflow</legend>
                    {triggers.map((item) => (
                      <label
                        key={item.value}
                        title={item.help}
                        className={draft.trigger === item.value ? "chosen" : ""}
                      >
                        <input
                          type="radio"
                          name="trigger"
                          checked={draft.trigger === item.value}
                          onChange={() => setDraft({ ...draft, trigger: item.value })}
                        />
                        <span>
                          <strong>{item.label}</strong>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  {draft.trigger === "schedule" && (
                    <label>
                      Repeat every
                      <select
                        value={draft.scheduleMinutes ?? 60}
                        onChange={(e) => setDraft({ ...draft, scheduleMinutes: Number(e.target.value) })}
                      >
                        {[
                          [15, "15 minutes"],
                          [30, "30 minutes"],
                          [60, "hour"],
                          [240, "4 hours"],
                          [1440, "day"],
                          [10080, "week"],
                        ].map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              {builderStep === "governance" && (
                <>
                  <p className="workflow-stage-kicker">STEP 4 · GOVERNANCE</p>
                  <h3>Control how this workflow operates</h3>
                  <small>
                    External write requests always become pending proposals. Add an approval checkpoint when someone
                    must review output first.
                  </small>
                  <section className="workflow-approval-checkpoint">
                    <div>
                      <p>APPROVAL CHECKPOINT</p>
                      <strong>Require review before a governed change</strong>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={approvalRequired}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, requiresApproval: event.target.checked }))
                        }
                      />
                      <span className="toggle-track" />
                    </label>
                  </section>
                  <label className="workflow-enabled">
                    <span>
                      <strong>Workflow active</strong>
                      <small>{draft.enabled ? "It can run when this trigger occurs." : "Saved but paused."}</small>
                    </span>
                    <span className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                      />
                      <span className="toggle-track" />
                    </span>
                  </label>
                  {selected && (
                    <button
                      type="button"
                      className="secondary-button workflow-test-button"
                      onClick={() => setShowTestLab((value) => !value)}
                    >
                      {showTestLab ? "Close test mode" : "Open safe test mode"}
                    </button>
                  )}
                  {showTestLab && selected && (
                    <section className="workflow-test-lab">
                      <label>
                        Sample event
                        <textarea
                          rows={3}
                          value={testEventText}
                          onChange={(e) => setTestEventText(e.target.value)}
                          placeholder="Describe the scenario to test."
                        />
                      </label>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={saving || !canModifyWorkflow}
                        onClick={() =>
                          void run(
                            draft.trigger === "manual" || draft.trigger === "schedule" ? "manual" : draft.trigger,
                            testEventText,
                          )
                        }
                      >
                        Run safe test
                      </button>
                    </section>
                  )}
                </>
              )}
              {builderStep === "review" && (
                <>
                  <p className="workflow-stage-kicker">STEP 5 · REVIEW</p>
                  <h3>Review this workflow</h3>
                  <small>You can go back to any step before saving.</small>
                  <dl className="workflow-review-summary">
                    <div>
                      <dt>Outcome</dt>
                      <dd>{draft.name || "Untitled workflow"}</dd>
                    </div>
                    <div>
                      <dt>Trigger</dt>
                      <dd>{labelForTrigger(draft.trigger)}</dd>
                    </div>
                    <div>
                      <dt>Agent</dt>
                      <dd>{draft.workspaceAgentId ? "Custom agent" : draft.agentKind}</dd>
                    </div>
                    <div>
                      <dt>Delivery</dt>
                      <dd>{draft.conversationId ? "Selected conversation" : "Dedicated conversation"}</dd>
                    </div>
                    <div>
                      <dt>Governance</dt>
                      <dd>{approvalRequired ? "Approval checkpoint" : "Governed proposals"}</dd>
                    </div>
                  </dl>
                </>
              )}
            </fieldset>
          </section>
          <div className="workflow-builder-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={builderStep === "identity"}
              onClick={() =>
                setBuilderStep(
                  (
                    {
                      identity: "identity",
                      execution: "identity",
                      delivery: "execution",
                      governance: "delivery",
                      review: "governance",
                    } as const
                  )[builderStep],
                )
              }
            >
              Back
            </button>
            {builderStep !== "review" ? (
              <button type="button" className="primary-button" onClick={continueBuilder}>
                Continue
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={saving || !canModifyWorkflow || !draft.name.trim() || !draft.instructions.trim()}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : selected ? "Save changes" : "Create workflow"}
              </button>
            )}
            {selected && (
              <button className="agent-delete-button" disabled={saving || !canModifyWorkflow} onClick={() => void remove()}>
                Delete
              </button>
            )}
          </div>
          {selected && !canEditSelectedWorkflow && (
            <aside className="workflow-diagnostic" data-testid="workflow-read-only">
              <strong>Read-only workflow</strong>
              <span>
                Only {selected.ownerName ?? "this workflow's owner"} or a workspace Admin can change, run, or delete it.
              </span>
            </aside>
          )}
          <AccessNotice
            workspaceId={workspaceId}
            access={access}
            permission="manageWorkflows"
            message="Creating, editing, deleting, enabling, scheduling, or running workflows requires the “Manage workflows” permission. You can still view definitions, run history, and diagnostics."
          />
          {error && <p className="error-text">{error}</p>}
          {notice && <p className="success-text">{notice}</p>}
          {selected && (
            <div className="workflow-runs">
              <div className="workflow-run-heading">
                <div>
                  <p className="eyebrow">EXECUTION HISTORY</p>
                  <h3>Runs and diagnostics</h3>
                </div>
                <div className="workflow-run-analytics">
                  <span>
                    <strong>
                      {runSuccessRate || "—"}
                      {runs.length ? "%" : ""}
                    </strong>
                    success rate
                  </span>
                  <span>
                    <strong>{runs.length}</strong>recorded runs
                  </span>
                </div>
              </div>
              {runs.length ? (
                <div className="workflow-run-timeline">
                  {runs.map((run) => (
                    <div key={run.id}>
                      <span className={`run-status ${run.status}`}>{run.status}</span>
                      <div>
                        <strong>{labelForTrigger(run.trigger)}</strong>
                        <small>
                          {formatDate(run.startedAt)}
                          {run.completedAt ? ` · completed ${formatDate(run.completedAt)}` : " · in progress"}
                        </small>
                        {run.detail && <p>{run.detail}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No runs yet. Use safe test mode to inspect a real workflow result.</p>
              )}
              {selected.lastRunError && (
                <aside className="workflow-diagnostic">
                  <strong>Last diagnostic</strong>
                  <span>{selected.lastRunError}</span>
                </aside>
              )}
              {selected.ownerIsMember === false && (
                <aside className="workflow-diagnostic" data-testid="workflow-owner-left">
                  <strong>Owner left the workspace</strong>
                  <span>
                    {selected.ownerName ?? "Its owner"} is no longer a member. Runs fail until someone takes it over.
                  </span>
                  {access.isAdmin && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={async () => {
                        try {
                          const updated = await takeOverWorkflow(workspaceId, selected.id);
                          setSelected(updated);
                          await refresh();
                          setNotice(`You now own ${updated.name}. It runs with your connections.`);
                        } catch (err) {
                          setError(describeError(err, "Could not take over this workflow."));
                        }
                      }}
                    >
                      Take over
                    </button>
                  )}
                </aside>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function SpecialistIcon({ kind }: { kind: (typeof agentKinds)[number] }) {
  if (kind === "project")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" fill="currentColor" />
      </svg>
    );
  if (kind === "github")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3.4a8.6 8.6 0 0 0-2.7 16.8c.4.1.5-.2.5-.4v-1.5c-2.1.5-2.5-.9-2.5-.9-.3-.9-.8-1.1-.8-1.1-.7-.5.1-.5.1-.5.7 0 1 .7 1 .7.6 1.1 1.7.8 2.1.6.1-.5.3-.8.5-1-1.7-.2-3.4-.8-3.4-3.7 0-.8.3-1.5.8-2-.1-.2-.4-1 .1-2 .6-.2 2 .8 2 .8a7 7 0 0 1 3.7 0s1.4-1 2-.8c.5 1 .2 1.8.1 2 .5.5.8 1.2.8 2 0 2.9-1.8 3.5-3.4 3.7.3.2.5.7.5 1.3v2c0 .2.1.5.5.4A8.6 8.6 0 0 0 12 3.4Z"
          fill="currentColor"
        />
      </svg>
    );
  if (kind === "slack")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M6.7 13.7a1.7 1.7 0 1 1-1.7-1.7h1.7v1.7Zm.9 0a1.7 1.7 0 1 1 3.4 0v4.2a1.7 1.7 0 1 1-3.4 0v-4.2ZM10.9 6.7A1.7 1.7 0 1 1 12.6 5v1.7h-1.7Zm0 .9a1.7 1.7 0 1 1 0 3.4H6.7a1.7 1.7 0 1 1 0-3.4h4.2ZM17.3 10.9A1.7 1.7 0 1 1 19 12.6h-1.7v-1.7Zm-.9 0a1.7 1.7 0 1 1-3.4 0V6.7a1.7 1.7 0 1 1 3.4 0v4.2ZM13.1 17.3a1.7 1.7 0 1 1-1.7 1.7v-1.7h1.7Zm0-.9a1.7 1.7 0 1 1 0-3.4h4.2a1.7 1.7 0 1 1 0 3.4h-4.2Z"
          fill="currentColor"
        />
      </svg>
    );
  if (kind === "linear")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="m4 5 15 14M4 10l9 9M9 4l10 10M15 4l5 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  if (kind === "notion")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="3" width="16" height="18" rx="1" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M8 17V7l8 10V7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="7" r="3" fill="currentColor" />
      <circle cx="15" cy="7" r="3" fill="currentColor" />
      <circle cx="9" cy="15" r="3" fill="currentColor" />
      <circle cx="15" cy="15" r="3" fill="currentColor" />
    </svg>
  );
}
function CustomAgentIcon({ name }: { name: string }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "AI";
  const hue = [...name].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
  return (
    <span
      className="workflow-custom-agent-icon"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 72% 48%), hsl(${(hue + 42) % 360} 75% 61%))` }}
    >
      {initials}
    </span>
  );
}
