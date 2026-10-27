// Workflows, workflow runs, scheduling and observability settings.
import type { WorkspaceWorkflow, WorkflowRun, WorkflowRunStatus, WorkflowTrigger } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";

type WorkflowInput = Pick<
  WorkspaceWorkflow,
  | "name"
  | "description"
  | "instructions"
  | "agentKind"
  | "workspaceAgentId"
  | "conversationId"
  | "trigger"
  | "scheduleMinutes"
  | "enabled"
> & { requiresApproval?: boolean };

function toWorkflow(row: Record<string, unknown>): WorkspaceWorkflow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    instructions: String(row.instructions ?? ""),
    agentKind: row.agent_kind as WorkspaceWorkflow["agentKind"],
    workspaceAgentId: row.workspace_agent_id ? String(row.workspace_agent_id) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    trigger: row.trigger as WorkflowTrigger,
    scheduleMinutes: row.schedule_minutes === null ? null : Number(row.schedule_minutes),
    enabled: Boolean(row.enabled),
    requiresApproval: Boolean(row.requires_approval),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    nextRunAt: row.next_run_at ? (row.next_run_at as Date).toISOString() : null,
    lastRunAt: row.last_run_at ? (row.last_run_at as Date).toISOString() : null,
    lastRunStatus: row.last_run_status as WorkflowRunStatus | null,
    lastRunError: row.last_run_error ? String(row.last_run_error) : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    ...("owner_is_member" in row
      ? { ownerName: row.owner_name ? String(row.owner_name) : null, ownerIsMember: Boolean(row.owner_is_member) }
      : {}),
  };
}

const WORKFLOW_WITH_OWNER = `SELECT w.*, u.display_name AS owner_name, (m.user_id IS NOT NULL) AS owner_is_member
  FROM workspace_workflows w
  LEFT JOIN users u ON u.id = w.owner_user_id
  LEFT JOIN workspace_members m ON m.workspace_id = w.workspace_id AND m.user_id = w.owner_user_id`;

function workflowScheduleDate(trigger: WorkflowTrigger, scheduleMinutes: number | null): Date | null {
  return trigger === "schedule" && scheduleMinutes ? new Date(Date.now() + scheduleMinutes * 60_000) : null;
}

export async function listWorkspaceWorkflows(workspaceId: string): Promise<WorkspaceWorkflow[]> {
  const result = await getPool().query(`${WORKFLOW_WITH_OWNER} WHERE w.workspace_id = $1 ORDER BY w.updated_at DESC`, [
    workspaceId,
  ]);
  return result.rows.map(toWorkflow);
}

export async function getWorkspaceWorkflow(workspaceId: string, workflowId: string): Promise<WorkspaceWorkflow | null> {
  const result = await getPool().query(`${WORKFLOW_WITH_OWNER} WHERE w.workspace_id = $1 AND w.id = $2`, [
    workspaceId,
    workflowId,
  ]);
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
}

export async function createWorkspaceWorkflow(
  workspaceId: string,
  ownerUserId: string,
  input: WorkflowInput,
): Promise<WorkspaceWorkflow> {
  const scheduleMinutes = input.trigger === "schedule" ? input.scheduleMinutes : null;
  const result = await getPool().query(
    `INSERT INTO workspace_workflows (workspace_id,name,description,instructions,agent_kind,workspace_agent_id,conversation_id,trigger,schedule_minutes,enabled,owner_user_id,next_run_at,requires_approval)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      workspaceId,
      input.name.trim(),
      input.description.trim(),
      input.instructions.trim(),
      input.agentKind,
      input.workspaceAgentId,
      input.conversationId,
      input.trigger,
      scheduleMinutes,
      input.enabled,
      ownerUserId,
      workflowScheduleDate(input.trigger, scheduleMinutes),
      input.requiresApproval ?? false,
    ],
  );
  return toWorkflow(result.rows[0]);
}

export async function updateWorkspaceWorkflow(
  workspaceId: string,
  workflowId: string,
  input: Partial<WorkflowInput>,
  editorUserId?: string,
): Promise<WorkspaceWorkflow | null> {
  const current = await getWorkspaceWorkflow(workspaceId, workflowId);
  if (!current) return null;
  const merged = {
    ...current,
    ...input,
    name: input.name?.trim() || current.name,
    description: input.description?.trim() ?? current.description,
    instructions: input.instructions?.trim() ?? current.instructions,
  };
  const scheduleMinutes = merged.trigger === "schedule" ? merged.scheduleMinutes : null;
  const nextRun = !merged.enabled ? null : workflowScheduleDate(merged.trigger, scheduleMinutes);
  const result = await getPool().query(
    `UPDATE workspace_workflows SET name=$3,description=$4,instructions=$5,agent_kind=$6,workspace_agent_id=$7,conversation_id=$8,trigger=$9,schedule_minutes=$10,enabled=$11,next_run_at=$12,requires_approval=$13,owner_user_id=COALESCE($14, owner_user_id),updated_at=now()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [
      workspaceId,
      workflowId,
      merged.name,
      merged.description,
      merged.instructions,
      merged.agentKind,
      merged.workspaceAgentId,
      merged.conversationId,
      merged.trigger,
      scheduleMinutes,
      merged.enabled,
      nextRun,
      merged.requiresApproval,
      editorUserId ?? null,
    ],
  );
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
}

export async function deleteWorkspaceWorkflow(
  workspaceId: string,
  workflowId: string,
): Promise<WorkspaceWorkflow | null> {
  const result = await getPool().query("DELETE FROM workspace_workflows WHERE workspace_id=$1 AND id=$2 RETURNING *", [
    workspaceId,
    workflowId,
  ]);
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
}

/** Makes a member the workflow's owner (an Admin taking over from someone who left). */
export async function setWorkflowOwner(
  workspaceId: string,
  workflowId: string,
  ownerUserId: string,
): Promise<WorkspaceWorkflow | null> {
  const result = await getPool().query(
    "UPDATE workspace_workflows SET owner_user_id=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id",
    [workspaceId, workflowId, ownerUserId],
  );
  return result.rows[0] ? getWorkspaceWorkflow(workspaceId, workflowId) : null;
}

/** Enabled workflows started by a GitHub or Slack event of this kind. */
export async function listEventWorkflows(workspaceId: string, trigger: WorkflowTrigger): Promise<WorkspaceWorkflow[]> {
  const result = await getPool().query(
    `${WORKFLOW_WITH_OWNER} WHERE w.workspace_id = $1 AND w.trigger = $2 AND w.enabled ORDER BY w.created_at ASC`,
    [workspaceId, trigger],
  );
  return result.rows.map(toWorkflow);
}

export async function setWorkflowConversation(workflowId: string, conversationId: string): Promise<void> {
  await getPool().query("UPDATE workspace_workflows SET conversation_id=$2, updated_at=now() WHERE id=$1", [
    workflowId,
    conversationId,
  ]);
}

export async function createWorkflowRun(workflow: WorkspaceWorkflow, trigger: WorkflowTrigger): Promise<WorkflowRun> {
  const result = await getPool().query(
    `INSERT INTO workspace_workflow_runs (workflow_id,workspace_id,trigger) VALUES ($1,$2,$3) RETURNING *`,
    [workflow.id, workflow.workspaceId, trigger],
  );
  await getPool().query(
    "UPDATE workspace_workflows SET last_run_at=now(),last_run_status='running',last_run_error=NULL,updated_at=now() WHERE id=$1",
    [workflow.id],
  );
  return toWorkflowRun(result.rows[0]);
}

/** A hard workspace-wide ceiling prevents a broken schedule or webhook from
 * consuming unlimited provider capacity. The INSERT is conditional so the
 * limit remains safe when multiple server instances race to start a run. */
export function workflowRunQuotaPerHour(): number {
  const configured = Number(process.env.WORKFLOW_RUNS_PER_WORKSPACE_PER_HOUR ?? 120);
  return Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 1), 10_000) : 120;
}

/** A noisy repository must not consume every workflow run in a workspace. */
export function githubWorkflowRunsPerRepositoryPerHour(): number {
  const configured = Number(process.env.GITHUB_WORKFLOW_RUNS_PER_REPOSITORY_PER_HOUR ?? 20);
  return Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 1), 1_000) : 20;
}

export function workflowCountLimit(): number {
  const configured = Number(process.env.WORKFLOWS_PER_WORKSPACE ?? 50);
  return Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 1), 1_000) : 50;
}

export async function countWorkspaceWorkflows(workspaceId: string): Promise<number> {
  const result = await getPool().query("SELECT count(*)::int AS count FROM workspace_workflows WHERE workspace_id=$1", [
    workspaceId,
  ]);
  return Number(result.rows[0]?.count ?? 0);
}

export async function hasWorkflowRunCapacity(workspaceId: string): Promise<boolean> {
  const result = await getPool().query(
    "SELECT count(*)::int AS count FROM workspace_workflow_runs WHERE workspace_id=$1 AND started_at >= now() - interval '1 hour'",
    [workspaceId],
  );
  return Number(result.rows[0]?.count ?? 0) < workflowRunQuotaPerHour();
}

export async function createWorkflowRunWithinQuota(
  workflow: WorkspaceWorkflow,
  trigger: WorkflowTrigger,
  sourceRepository: string | null = null,
): Promise<WorkflowRun | null> {
  const result = await getPool().query(
    `WITH workspace_capacity AS (
       SELECT count(*) < $3::int AS allowed FROM workspace_workflow_runs
       WHERE workspace_id=$2 AND started_at >= now() - interval '1 hour'
     ), repository_capacity AS (
       SELECT $5::text IS NULL OR count(*) < $6::int AS allowed FROM workspace_workflow_runs
       WHERE workspace_id=$2 AND source_repository=$5 AND started_at >= now() - interval '1 hour'
     ), inserted AS (
       INSERT INTO workspace_workflow_runs (workflow_id,workspace_id,trigger,source_repository)
       SELECT $1,$2,$4,$5
       WHERE (SELECT allowed FROM workspace_capacity) AND (SELECT allowed FROM repository_capacity)
       RETURNING *
     ) SELECT * FROM inserted`,
    [
      workflow.id,
      workflow.workspaceId,
      workflowRunQuotaPerHour(),
      trigger,
      sourceRepository,
      githubWorkflowRunsPerRepositoryPerHour(),
    ],
  );
  if (!result.rows[0]) return null;
  await getPool().query(
    "UPDATE workspace_workflows SET last_run_at=now(),last_run_status='running',last_run_error=NULL,updated_at=now() WHERE id=$1",
    [workflow.id],
  );
  return toWorkflowRun(result.rows[0]);
}

function toWorkflowRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    workspaceId: String(row.workspace_id),
    trigger: row.trigger as WorkflowTrigger,
    status: row.status as WorkflowRunStatus,
    detail: row.detail ? String(row.detail) : null,
    startedAt: (row.started_at as Date).toISOString(),
    completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
    toolCalls: Number(row.tool_calls ?? 0),
    estimatedTokens: Number(row.estimated_tokens ?? 0),
    estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
    providerPromptTokens:
      row.provider_prompt_tokens === null || row.provider_prompt_tokens === undefined
        ? null
        : Number(row.provider_prompt_tokens),
    providerCompletionTokens:
      row.provider_completion_tokens === null || row.provider_completion_tokens === undefined
        ? null
        : Number(row.provider_completion_tokens),
    providerCostUsd:
      row.provider_cost_usd === null || row.provider_cost_usd === undefined ? null : Number(row.provider_cost_usd),
    outputExcerpt: row.output_excerpt ? String(row.output_excerpt) : null,
    inputExcerpt: row.input_excerpt ? String(row.input_excerpt) : null,
    toolTrace: Array.isArray(row.tool_trace)
      ? (row.tool_trace as Array<{ name: string; durationMs: number; status: "succeeded" | "failed" }>)
      : [],
  };
}

export async function finishWorkflowRun(
  workflowId: string,
  runId: string,
  status: Exclude<WorkflowRunStatus, "running">,
  detail?: string,
  telemetry?: {
    toolCalls: number;
    estimatedTokens: number;
    estimatedCostUsd: number;
    providerPromptTokens?: number | null;
    providerCompletionTokens?: number | null;
    providerCostUsd?: number | null;
    outputExcerpt?: string;
    inputExcerpt?: string | null;
    toolTrace?: Array<{ name: string; durationMs: number; status: "succeeded" | "failed" }>;
  },
): Promise<void> {
  await getPool().query(
    "UPDATE workspace_workflow_runs SET status=$3,detail=$4,tool_calls=$5,estimated_tokens=$6,estimated_cost_usd=$7,provider_prompt_tokens=$8,provider_completion_tokens=$9,provider_cost_usd=$10,output_excerpt=$11,input_excerpt=$12,tool_trace=$13,completed_at=now() WHERE id=$1 AND workflow_id=$2",
    [
      runId,
      workflowId,
      status,
      detail ?? null,
      telemetry?.toolCalls ?? 0,
      telemetry?.estimatedTokens ?? 0,
      telemetry?.estimatedCostUsd ?? 0,
      telemetry?.providerPromptTokens ?? null,
      telemetry?.providerCompletionTokens ?? null,
      telemetry?.providerCostUsd ?? null,
      telemetry?.outputExcerpt ?? null,
      telemetry?.inputExcerpt ?? null,
      JSON.stringify(telemetry?.toolTrace ?? []),
    ],
  );
  await getPool().query(
    "UPDATE workspace_workflows SET last_run_status=$2,last_run_error=$3,updated_at=now() WHERE id=$1",
    [workflowId, status, status === "failed" ? (detail ?? "Workflow failed.") : null],
  );
}

/** Number of failures in the active alert window, including the just-finished run. */
export async function countRecentFailedWorkflowRuns(
  workspaceId: string,
  hours = 24,
  workflowId?: string,
): Promise<number> {
  const result = await getPool().query(
    "SELECT count(*)::int AS count FROM workspace_workflow_runs WHERE workspace_id=$1 AND ($3::uuid IS NULL OR workflow_id=$3) AND status='failed' AND completed_at >= now() - ($2::int * interval '1 hour')",
    [workspaceId, hours, workflowId ?? null],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getObservabilityRetentionPolicy(
  workspaceId: string,
): Promise<import("@mai-chat/shared-types").ObservabilityRetentionPolicy> {
  const result = await getPool().query(
    "SELECT workflow_run_retention_days,failure_alert_threshold,updated_at FROM workspace_observability_settings WHERE workspace_id=$1",
    [workspaceId],
  );
  const row = result.rows[0];
  return {
    workspaceId,
    retentionDays: (row?.workflow_run_retention_days ?? 30) as 7 | 30 | 90 | 365,
    failureAlertThreshold: row?.failure_alert_threshold ?? defaultFailureAlertThreshold(),
    updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
  };
}

function defaultFailureAlertThreshold(): number {
  const configured = Number(process.env.WORKFLOW_FAILURE_ALERT_THRESHOLD ?? 3);
  return Number.isFinite(configured) ? Math.max(1, Math.round(configured)) : 3;
}

/** Saves the Admin-set failure-alert threshold (1-20 failed runs in 24 hours). */
export async function updateFailureAlertThreshold(
  workspaceId: string,
  threshold: number,
): Promise<import("@mai-chat/shared-types").ObservabilityRetentionPolicy> {
  await getPool().query(
    "INSERT INTO workspace_observability_settings (workspace_id,failure_alert_threshold) VALUES ($1,$2) ON CONFLICT (workspace_id) DO UPDATE SET failure_alert_threshold=EXCLUDED.failure_alert_threshold,updated_at=now()",
    [workspaceId, threshold],
  );
  return getObservabilityRetentionPolicy(workspaceId);
}

export async function updateObservabilityRetentionPolicy(
  workspaceId: string,
  retentionDays: 7 | 30 | 90 | 365,
): Promise<import("@mai-chat/shared-types").ObservabilityRetentionPolicy> {
  const result = await getPool().query(
    "INSERT INTO workspace_observability_settings (workspace_id,workflow_run_retention_days) VALUES ($1,$2) ON CONFLICT (workspace_id) DO UPDATE SET workflow_run_retention_days=EXCLUDED.workflow_run_retention_days,updated_at=now() RETURNING workflow_run_retention_days,failure_alert_threshold,updated_at",
    [workspaceId, retentionDays],
  );
  const row = result.rows[0];
  return {
    workspaceId,
    retentionDays: row.workflow_run_retention_days as 7 | 30 | 90 | 365,
    failureAlertThreshold: row.failure_alert_threshold ?? defaultFailureAlertThreshold(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Deletes expired workflow runs according to each workspace's saved policy. */
export async function enforceWorkflowRunRetention(workspaceId?: string): Promise<number> {
  const result = await getPool().query(
    "DELETE FROM workspace_workflow_runs runs WHERE ($1::uuid IS NULL OR runs.workspace_id=$1) AND runs.started_at < now() - (COALESCE((SELECT settings.workflow_run_retention_days FROM workspace_observability_settings settings WHERE settings.workspace_id=runs.workspace_id), 30) * interval '1 day')",
    [workspaceId ?? null],
  );
  return result.rowCount ?? 0;
}

export async function listWorkflowRuns(
  workspaceId: string,
  workflowId: string,
  options: { limit?: number; before?: string } = {},
): Promise<WorkflowRun[]> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  const result = await getPool().query(
    "SELECT r.* FROM workspace_workflow_runs r WHERE r.workspace_id=$1 AND r.workflow_id=$2 AND ($3::timestamptz IS NULL OR r.started_at < $3) ORDER BY r.started_at DESC LIMIT $4",
    [workspaceId, workflowId, options.before ?? null, limit],
  );
  return result.rows.map(toWorkflowRun);
}

/** Recent runs across every workflow in a workspace, newest first, with each workflow's name (one query for Observability). */
export async function listWorkspaceWorkflowRuns(
  workspaceId: string,
  options: { limit?: number; before?: string } = {},
): Promise<Array<WorkflowRun & { workflowName: string }>> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 500);
  const result = await getPool().query(
    "SELECT r.*, w.name AS workflow_name FROM workspace_workflow_runs r JOIN workspace_workflows w ON w.id = r.workflow_id WHERE r.workspace_id=$1 AND ($2::timestamptz IS NULL OR r.started_at < $2) ORDER BY r.started_at DESC LIMIT $3",
    [workspaceId, options.before ?? null, limit],
  );
  return result.rows.map((row) => ({ ...toWorkflowRun(row), workflowName: String(row.workflow_name) }));
}

// Claim due schedules atomically before execution. Updating next_run_at here
// prevents overlapping scheduler ticks from starting the same workflow twice.
export async function claimDueWorkflows(): Promise<WorkspaceWorkflow[]> {
  const result = await getPool().query(
    `WITH due AS (SELECT id FROM workspace_workflows WHERE enabled AND trigger='schedule' AND next_run_at <= now() FOR UPDATE SKIP LOCKED)
     UPDATE workspace_workflows w SET next_run_at=now() + (w.schedule_minutes * interval '1 minute'), updated_at=now()
     FROM due WHERE w.id=due.id RETURNING w.*`,
  );
  return result.rows.map(toWorkflow);
}
