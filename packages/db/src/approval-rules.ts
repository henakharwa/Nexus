// Approval rules and the per-person approvals they require.
import type { ApprovalActionCategory, ApprovalRule, ApprovalRuleInput, IntegrationType, PendingActionApproval, StandingApproval } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";

function toApprovalRule(row: Record<string, unknown>): ApprovalRule {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    provider: (row.provider as IntegrationType | null) ?? null,
    categories: (Array.isArray(row.categories) ? row.categories : []) as ApprovalActionCategory[],
    repoPattern: (row.repo_pattern as string | null) ?? null,
    branchPattern: (row.branch_pattern as string | null) ?? null,
    channelPattern: (row.channel_pattern as string | null) ?? null,
    effect: row.effect as ApprovalRule["effect"],
    requiredApprovals: row.required_approvals === null || row.required_approvals === undefined ? null : Number(row.required_approvals),
    createdByName: (row.created_by_name as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function listApprovalRules(workspaceId: string): Promise<ApprovalRule[]> {
  const result = await getPool().query("SELECT * FROM approval_rules WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC", [workspaceId]);
  return result.rows.map(toApprovalRule);
}

export async function getApprovalRule(workspaceId: string, id: string): Promise<ApprovalRule | null> {
  const result = await getPool().query("SELECT * FROM approval_rules WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
  return result.rows[0] ? toApprovalRule(result.rows[0]) : null;
}

export async function countApprovalRules(workspaceId: string): Promise<number> {
  const result = await getPool().query("SELECT count(*)::int AS n FROM approval_rules WHERE workspace_id = $1", [workspaceId]);
  return result.rows[0].n as number;
}

export async function createApprovalRule(workspaceId: string, input: ApprovalRuleInput, createdBy: { userId: string; name: string }): Promise<ApprovalRule> {
  const result = await getPool().query(
    `INSERT INTO approval_rules (workspace_id, name, enabled, provider, categories, repo_pattern, branch_pattern, channel_pattern, effect, required_approvals, created_by_user_id, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [workspaceId, input.name, input.enabled, input.provider, input.categories, input.repoPattern, input.branchPattern, input.channelPattern, input.effect, input.effect === "require_approvals" ? input.requiredApprovals : null, createdBy.userId, createdBy.name]
  );
  return toApprovalRule(result.rows[0]);
}

export async function updateApprovalRule(workspaceId: string, id: string, input: ApprovalRuleInput): Promise<ApprovalRule | null> {
  const result = await getPool().query(
    `UPDATE approval_rules SET name = $3, enabled = $4, provider = $5, categories = $6, repo_pattern = $7, branch_pattern = $8, channel_pattern = $9, effect = $10, required_approvals = $11, updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING *`,
    [workspaceId, id, input.name, input.enabled, input.provider, input.categories, input.repoPattern, input.branchPattern, input.channelPattern, input.effect, input.effect === "require_approvals" ? input.requiredApprovals : null]
  );
  return result.rows[0] ? toApprovalRule(result.rows[0]) : null;
}

export async function deleteApprovalRule(workspaceId: string, id: string): Promise<boolean> {
  const result = await getPool().query("DELETE FROM approval_rules WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
  return (result.rowCount ?? 0) > 0;
}

/** Records one person's approval. Returns false when they had already approved. */
export async function recordActionApproval(actionId: string, user: { userId: string; name: string }): Promise<boolean> {
  const result = await getPool().query(
    "INSERT INTO pending_action_approvals (action_id, user_id, user_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [actionId, user.userId, user.name]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Approvals for each of the given actions, oldest first. */
export async function listActionApprovals(actionIds: string[]): Promise<Map<string, PendingActionApproval[]>> {
  const byAction = new Map<string, PendingActionApproval[]>();
  if (actionIds.length === 0) return byAction;
  const result = await getPool().query(
    "SELECT action_id, user_id, user_name, created_at FROM pending_action_approvals WHERE action_id = ANY($1::uuid[]) ORDER BY created_at ASC",
    [actionIds]
  );
  for (const row of result.rows) {
    const list = byAction.get(row.action_id) ?? [];
    list.push({ userId: row.user_id, name: row.user_name, approvedAt: (row.created_at as Date).toISOString() });
    byAction.set(row.action_id, list);
  }
  return byAction;
}

// -- Standing approvals ---------------------------------------------------

function toStandingApproval(row: Record<string, unknown>): StandingApproval {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider: row.provider as IntegrationType,
    toolName: String(row.tool_name),
    scope: String(row.scope),
    scopeLabel: String(row.scope_label),
    description: String(row.description),
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
    createdByName: String(row.created_by_name),
    createdAt: (row.created_at as Date).toISOString(),
    expiresAt: (row.expires_at as Date).toISOString(),
  };
}

export async function createStandingApproval(input: {
  workspaceId: string;
  provider: IntegrationType;
  toolName: string;
  scope: string;
  scopeLabel: string;
  description: string;
  createdBy: { userId: string; name: string };
  sourceActionId: string | null;
  days: number;
}): Promise<StandingApproval> {
  // A newer approval for the same thing replaces the older one.
  await getPool().query(
    "UPDATE standing_approvals SET revoked_at = now(), revoked_by_name = $5 WHERE workspace_id = $1 AND provider = $2 AND tool_name = $3 AND scope = $4 AND revoked_at IS NULL AND expires_at > now()",
    [input.workspaceId, input.provider, input.toolName, input.scope, input.createdBy.name]
  );
  const result = await getPool().query(
    `INSERT INTO standing_approvals (workspace_id, provider, tool_name, scope, scope_label, description, created_by_user_id, created_by_name, source_action_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10::int * interval '1 day')) RETURNING *`,
    [input.workspaceId, input.provider, input.toolName, input.scope, input.scopeLabel, input.description, input.createdBy.userId, input.createdBy.name, input.sourceActionId, input.days]
  );
  return toStandingApproval(result.rows[0]);
}

/** The active standing approval covering this kind of action, if any. */
export async function findStandingApproval(workspaceId: string, provider: IntegrationType, toolName: string, scope: string): Promise<StandingApproval | null> {
  const result = await getPool().query(
    `SELECT * FROM standing_approvals WHERE workspace_id = $1 AND provider = $2 AND tool_name = $3 AND scope = $4 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, provider, toolName, scope]
  );
  return result.rows[0] ? toStandingApproval(result.rows[0]) : null;
}

export async function listStandingApprovals(workspaceId: string): Promise<StandingApproval[]> {
  const result = await getPool().query(
    "SELECT * FROM standing_approvals WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 200",
    [workspaceId]
  );
  return result.rows.map(toStandingApproval);
}

export async function getStandingApproval(workspaceId: string, id: string): Promise<StandingApproval | null> {
  const result = await getPool().query("SELECT * FROM standing_approvals WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL AND expires_at > now()", [workspaceId, id]);
  return result.rows[0] ? toStandingApproval(result.rows[0]) : null;
}

export async function revokeStandingApproval(workspaceId: string, id: string, revokedByName: string): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE standing_approvals SET revoked_at = now(), revoked_by_name = $3 WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL",
    [workspaceId, id, revokedByName]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Members whose role lets them approve actions (Admins, plus Editors when the policy allows). */
export async function countWorkspaceApprovers(workspaceId: string): Promise<number> {
  const result = await getPool().query(
    `SELECT count(*)::int AS n FROM workspace_members m
     LEFT JOIN workspace_permission_policies p ON p.workspace_id = m.workspace_id
     WHERE m.workspace_id = $1 AND (m.role = 'admin' OR (m.role = 'editor' AND COALESCE((p.editor_permissions->>'approveActions')::boolean, false)))`,
    [workspaceId]
  );
  return result.rows[0].n as number;
}
