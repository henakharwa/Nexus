// Workspace permission policy and permission requests.
import type { WorkspaceRole, WorkspacePermissionPolicy, WorkspacePermissions } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";

const DEFAULT_ADMIN_PERMISSIONS: WorkspacePermissions = {
  connectTools: true,
  createAgents: true,
  publishAgents: true,
  manageWorkflows: true,
  manageMemory: true,
  manageArtifacts: true,
  approveActions: true,
  github: true,
  slack: true,
  linear: true,
  notion: true,
  figma: true,
};
// Keep the capabilities Editors already had by default (memory and artifact
// management), while workflows remain an Admin-granted capability.
const DEFAULT_EDITOR_PERMISSIONS: WorkspacePermissions = {
  connectTools: true,
  createAgents: false,
  publishAgents: false,
  manageWorkflows: false,
  manageMemory: true,
  manageArtifacts: true,
  approveActions: false,
  github: true,
  slack: true,
  linear: true,
  notion: true,
  figma: true,
};

function sanitizePermissions(value: unknown, fallback: WorkspacePermissions): WorkspacePermissions {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.keys(fallback).map((key) => [
      key,
      typeof source[key] === "boolean" ? source[key] : fallback[key as keyof WorkspacePermissions],
    ]),
  ) as unknown as WorkspacePermissions;
}

export async function getWorkspacePermissionPolicy(workspaceId: string): Promise<WorkspacePermissionPolicy> {
  const result = await getPool().query(
    `SELECT admin_permissions, editor_permissions FROM workspace_permission_policies WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  return {
    admin: sanitizePermissions(row?.admin_permissions, DEFAULT_ADMIN_PERMISSIONS),
    editor: sanitizePermissions(row?.editor_permissions, DEFAULT_EDITOR_PERMISSIONS),
  };
}

export async function setWorkspacePermissionPolicy(
  workspaceId: string,
  policy: WorkspacePermissionPolicy,
): Promise<WorkspacePermissionPolicy> {
  const admin = sanitizePermissions(policy.admin, DEFAULT_ADMIN_PERMISSIONS);
  const editor = sanitizePermissions(policy.editor, DEFAULT_EDITOR_PERMISSIONS);
  await getPool().query(
    `INSERT INTO workspace_permission_policies (workspace_id, admin_permissions, editor_permissions, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (workspace_id) DO UPDATE SET admin_permissions = $2, editor_permissions = $3, updated_at = now()`,
    [workspaceId, JSON.stringify(admin), JSON.stringify(editor)],
  );
  return { admin, editor };
}

export async function hasWorkspacePermission(
  workspaceId: string,
  role: WorkspaceRole,
  permission: keyof WorkspacePermissions,
): Promise<boolean> {
  return hasWorkspacePermissionForUser(workspaceId, role, undefined, permission);
}

export async function listWorkspaceMemberPermissionGrants(
  workspaceId: string,
  userId: string,
): Promise<Array<keyof WorkspacePermissions>> {
  const result = await getPool().query(
    `SELECT permission FROM workspace_member_permission_grants WHERE workspace_id = $1 AND user_id = $2 ORDER BY permission`,
    [workspaceId, userId],
  );
  return result.rows.map((row) => row.permission as keyof WorkspacePermissions);
}

export async function setWorkspaceMemberPermissionGrant(
  workspaceId: string,
  userId: string,
  permission: keyof WorkspacePermissions,
  granted: boolean,
): Promise<void> {
  if (granted) {
    await getPool().query(
      `INSERT INTO workspace_member_permission_grants (workspace_id, user_id, permission)
       VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id, permission) DO NOTHING`,
      [workspaceId, userId, permission],
    );
    return;
  }
  await getPool().query(
    `DELETE FROM workspace_member_permission_grants WHERE workspace_id = $1 AND user_id = $2 AND permission = $3`,
    [workspaceId, userId, permission],
  );
}

export async function getEffectiveWorkspacePermissions(
  workspaceId: string,
  role: WorkspaceRole,
  userId?: string,
): Promise<WorkspacePermissions> {
  const policy = await getWorkspacePermissionPolicy(workspaceId);
  if (role === "admin")
    return Object.fromEntries(Object.keys(policy.admin).map((key) => [key, true])) as unknown as WorkspacePermissions;
  const grants = userId ? await listWorkspaceMemberPermissionGrants(workspaceId, userId) : [];
  return {
    ...policy.editor,
    ...Object.fromEntries(grants.map((permission) => [permission, true])),
  } as unknown as WorkspacePermissions;
}

export async function hasWorkspacePermissionForUser(
  workspaceId: string,
  role: WorkspaceRole,
  userId: string | undefined,
  permission: keyof WorkspacePermissions,
): Promise<boolean> {
  return (await getEffectiveWorkspacePermissions(workspaceId, role, userId))[permission];
}
export async function createPermissionRequest(
  workspaceId: string,
  userId: string,
  permission: keyof WorkspacePermissions,
  reason: string,
) {
  const r = await getPool().query(
    `INSERT INTO workspace_permission_requests (workspace_id,user_id,permission,reason) VALUES ($1,$2,$3,$4)
     RETURNING id,permission,reason,status,created_at`,
    [workspaceId, userId, permission, reason],
  );
  return r.rows[0];
}
export async function listPermissionRequests(workspaceId: string) {
  const r = await getPool().query(
    `SELECT r.id,r.user_id,r.permission,r.reason,r.status,r.created_at,u.display_name,u.username
     FROM workspace_permission_requests r JOIN users u ON u.id=r.user_id
     WHERE r.workspace_id=$1 AND r.status='pending' ORDER BY r.created_at DESC`,
    [workspaceId],
  );
  return r.rows;
}
export async function resolvePermissionRequest(workspaceId: string, id: string, status: "approved" | "denied") {
  const r = await getPool().query(
    `UPDATE workspace_permission_requests SET status=$3,resolved_at=now()
     WHERE workspace_id=$1 AND id=$2 AND status='pending'
     RETURNING user_id,permission,reason`,
    [workspaceId, id, status],
  );
  return r.rows[0] as { user_id: string; permission: keyof WorkspacePermissions; reason: string } | undefined;
}
