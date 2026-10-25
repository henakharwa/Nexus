// Workspaces, join codes, invitations and membership.
import { randomBytes } from "node:crypto";
import type { WorkspaceInvitation, User, WorkspaceMember, WorkspaceRole, Workspace } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";
import { hashSessionToken } from "./crypto.js";

import { normalizedEmail, toUser } from "./users.js";

function generateJoinCode(): string {
  // 6 url-safe chars, e.g. "a1b2c3" -- short enough to read aloud, long
  // enough (62^6 ~= 56 billion) that guessing a live workspace is not a
  // realistic Phase 1 threat model.
  return randomBytes(6).toString("base64url").slice(0, 6);
}

export class WorkspaceNameTakenError extends Error {
  workspace: Workspace;
  constructor(workspace: Workspace) {
    super("A workspace with this name already exists.");
    this.name = "WorkspaceNameTakenError";
    this.workspace = workspace;
  }
}

export function normalizeWorkspaceName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export async function createWorkspace(name: string, createdByUserId?: string | null): Promise<Workspace> {
  const normalizedName = normalizeWorkspaceName(name);
  if (!normalizedName) throw new Error("workspace name is required");
  const client = await getPool().connect();
  // Collisions are astronomically unlikely at this scale, but retry once
  // rather than assume -- a UNIQUE constraint violation is real and cheap
  // to recover from.
  try {
    await client.query("BEGIN");
    // A transaction lock makes the case/whitespace-insensitive lookup safe
    // even when two browser tabs submit the same name at the same time.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [normalizedName.toLowerCase()]);
    const existing = await client.query(
      `SELECT id, name, join_code, created_at FROM workspaces
       WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = $1
         AND created_by IS NOT DISTINCT FROM $2
       LIMIT 1`,
      [normalizedName.toLowerCase(), createdByUserId ?? null],
    );
    if (existing.rows[0]) throw new WorkspaceNameTakenError(toWorkspace(existing.rows[0]));
    for (let attempt = 0; attempt < 3; attempt++) {
      const joinCode = generateJoinCode();
      try {
        const result = await client.query(
          `INSERT INTO workspaces (name, join_code, created_by) VALUES ($1, $2, $3)
           RETURNING id, name, join_code, created_at`,
          [normalizedName, joinCode, createdByUserId ?? null],
        );
        await client.query("COMMIT");
        return toWorkspace(result.rows[0]);
      } catch (err: unknown) {
        const isUniqueViolation =
          typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505";
        if (!isUniqueViolation || attempt === 2) throw err;
      }
    }
    throw new Error("failed to generate a unique join code");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Records that a signed-in user has been in a workspace -- NOT an access
// gate (see the baseline migration's comment on the workspace_members table); called
// once per (workspace, user) the first time they open it, whether by
// creating it or following a join-code link. Idempotent.
// Returns true the first time this (workspace, user) pair is recorded,
// false on every call after that -- callers use this to log a "member
// joined" audit event exactly once per person, not on every reconnect
// (addWorkspaceMember itself runs on every WebSocket connection).
export async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = "admin",
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING
     RETURNING workspace_id`,
    [workspaceId, userId, role],
  );
  return (result.rowCount ?? 0) > 0;
}

const WORKSPACE_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function isWorkspaceMemberEmail(workspaceId: string, email: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM workspace_members wm JOIN user_email_identities ei ON ei.user_id = wm.user_id
     WHERE wm.workspace_id = $1 AND ei.email = $2 LIMIT 1`,
    [workspaceId, normalizedEmail(email)],
  );
  return Boolean(result.rows[0]);
}

export async function createWorkspaceInvitation(input: {
  workspaceId: string;
  email: string;
  invitedByUserId: string;
  role: WorkspaceRole;
}): Promise<{ token: string; email: string; role: WorkspaceRole; expiresAt: string }> {
  const email = normalizedEmail(input.email);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WORKSPACE_INVITATION_TTL_MS);
  await getPool().query(
    `INSERT INTO workspace_invitations (token_hash, workspace_id, email, invited_by_user_id, role, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, email) WHERE accepted_at IS NULL
     DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       invited_by_user_id = EXCLUDED.invited_by_user_id,
       role = EXCLUDED.role,
       created_at = now(),
       expires_at = EXCLUDED.expires_at`,
    [hashSessionToken(token), input.workspaceId, email, input.invitedByUserId, input.role, expiresAt],
  );
  return { token, email, role: input.role, expiresAt: expiresAt.toISOString() };
}

export async function deleteWorkspaceInvitation(token: string): Promise<void> {
  await getPool().query("DELETE FROM workspace_invitations WHERE token_hash = $1", [hashSessionToken(token)]);
}

export async function listWorkspaceInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
  const result = await getPool().query(
    `SELECT token_hash, email, role, created_at, expires_at FROM workspace_invitations
     WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.token_hash,
    email: row.email,
    role: row.role as WorkspaceRole,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}

export async function revokeWorkspaceInvitation(workspaceId: string, invitationId: string): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM workspace_invitations WHERE workspace_id = $1 AND token_hash = $2 AND accepted_at IS NULL",
    [workspaceId, invitationId],
  );
  return result.rowCount === 1;
}

export type AcceptWorkspaceInvitationResult =
  { kind: "accepted"; workspaceId: string } | { kind: "invalid" } | { kind: "email_mismatch"; email: string };

export async function acceptWorkspaceInvitation(
  token: string,
  userId: string,
): Promise<AcceptWorkspaceInvitationResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const invite = await client.query(
      `SELECT workspace_id, email, role FROM workspace_invitations
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hashSessionToken(token)],
    );
    if (!invite.rows[0]) {
      await client.query("COMMIT");
      return { kind: "invalid" };
    }
    const invitedEmail = invite.rows[0].email as string;
    // An account can legitimately have more than one verified identity (for
    // example, a password sign-in plus a linked OAuth provider). The invite
    // must match any verified identity, rather than whichever one happened to
    // be verified most recently.
    const identity = await client.query(
      `SELECT 1 FROM user_email_identities WHERE user_id = $1 AND email = $2
       UNION ALL
       SELECT 1 FROM password_credentials WHERE user_id = $1 AND email = $2
       LIMIT 1`,
      [userId, invitedEmail],
    );
    if (!identity.rows[0]) {
      await client.query("COMMIT");
      return { kind: "email_mismatch", email: invitedEmail };
    }
    const workspaceId = invite.rows[0].workspace_id as string;
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId, invite.rows[0].role],
    );
    await client.query("UPDATE workspace_invitations SET accepted_at = now() WHERE token_hash = $1", [
      hashSessionToken(token),
    ]);
    await client.query("COMMIT");
    return { kind: "accepted", workspaceId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getWorkspaceById(id: string): Promise<Workspace | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT id, name, join_code, created_at FROM workspaces WHERE id = $1`, [id]);
  return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function getWorkspaceByJoinCode(joinCode: string): Promise<Workspace | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT id, name, join_code, created_at FROM workspaces WHERE join_code = $1`, [
    joinCode,
  ]);
  return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function rotateWorkspaceJoinCode(workspaceId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateJoinCode();
    try {
      const result = await getPool().query(`UPDATE workspaces SET join_code = $2 WHERE id = $1 RETURNING join_code`, [
        workspaceId,
        code,
      ]);
      if (!result.rows[0]) throw new Error("workspace not found");
      return result.rows[0].join_code;
    } catch (error: unknown) {
      if (
        !(typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") ||
        attempt === 2
      )
        throw error;
    }
  }
  throw new Error("failed to rotate join code");
}

export async function getWorkspaceJoinApprovalRequired(workspaceId: string): Promise<boolean> {
  const result = await getPool().query(`SELECT join_approval_required FROM workspaces WHERE id = $1`, [workspaceId]);
  return Boolean(result.rows[0]?.join_approval_required);
}

export async function setWorkspaceJoinApprovalRequired(workspaceId: string, required: boolean): Promise<void> {
  await getPool().query(`UPDATE workspaces SET join_approval_required = $2 WHERE id = $1`, [workspaceId, required]);
}

export async function createWorkspaceJoinRequest(
  workspaceId: string,
  userId: string,
): Promise<{ id: string; alreadyPending: boolean }> {
  const result = await getPool().query(
    `INSERT INTO workspace_join_requests (workspace_id, user_id) VALUES ($1, $2)
     ON CONFLICT (workspace_id, user_id) WHERE status = 'pending' DO NOTHING RETURNING id`,
    [workspaceId, userId],
  );
  if (result.rows[0]) return { id: result.rows[0].id, alreadyPending: false };
  const existing = await getPool().query(
    `SELECT id FROM workspace_join_requests WHERE workspace_id = $1 AND user_id = $2 AND status = 'pending'`,
    [workspaceId, userId],
  );
  return { id: existing.rows[0].id, alreadyPending: true };
}

export async function listWorkspaceJoinRequests(
  workspaceId: string,
): Promise<Array<{ id: string; userId: string; displayName: string; email: string | null; createdAt: string }>> {
  const result = await getPool().query(
    `SELECT r.id, r.user_id, u.display_name, pc.email, r.created_at FROM workspace_join_requests r
     JOIN users u ON u.id = r.user_id LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE r.workspace_id = $1 AND r.status = 'pending' ORDER BY r.created_at ASC`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function resolveWorkspaceJoinRequest(
  workspaceId: string,
  requestId: string,
  approverUserId: string,
  approve: boolean,
): Promise<{ userId: string } | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const request = await client.query(
      `UPDATE workspace_join_requests SET status = $4, resolved_at = now(), resolved_by_user_id = $3 WHERE id = $2 AND workspace_id = $1 AND status = 'pending' RETURNING user_id`,
      [workspaceId, requestId, approverUserId, approve ? "approved" : "denied"],
    );
    if (!request.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    if (approve)
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING`,
        [workspaceId, request.rows[0].user_id],
      );
    await client.query("COMMIT");
    return { userId: request.rows[0].user_id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Deletes the workspace and all workspace-scoped data through database cascades. */
export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  const result = await getPool().query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  return result.rowCount === 1;
}

// A user's home screen only needs workspaces they are already a recorded
// member of; it must not become a directory of every workspace in the app.
export async function listWorkspacesForUser(
  userId: string,
): Promise<import("@mai-chat/shared-types").WorkspaceMembership[]> {
  const result = await getPool().query(
    `SELECT w.id, w.name, w.join_code, w.created_at, wm.role
     FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = $1 ORDER BY w.created_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({ ...toWorkspace(row), role: row.role }));
}

function toWorkspace(row: { id: string; name: string; join_code: string; created_at: Date }): Workspace {
  return {
    id: row.id,
    name: row.name,
    joinCode: row.join_code,
    createdAt: row.created_at.toISOString(),
  };
}

// Real workspace membership (packages/db's workspace_members table),
// unlike RoomRegistry.participants() in services/chat-server/src/
// rooms.ts, which only lists who's currently connected. @-mention
// matching needs this broader list -- handing a task to a teammate who's
// not online right now should still resolve their @mention correctly, so
// they see it directed at them once they're back. Ordered by join time,
// most senior member first, since there's no other ordering that means
// anything here yet.
export async function listWorkspaceMembers(workspaceId: string): Promise<User[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT u.id, u.github_id, u.username, u.display_name, u.avatar_url, u.created_at,
            pc.email, pc.email_verified_at
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE wm.workspace_id = $1
     ORDER BY wm.joined_at ASC`,
    [workspaceId],
  );
  return result.rows.map(toUser);
}

export async function listWorkspaceMembersWithRoles(workspaceId: string): Promise<WorkspaceMember[]> {
  const result = await getPool().query(
    `SELECT u.id, u.github_id, u.username, u.display_name, u.avatar_url, u.created_at, pc.email, pc.email_verified_at, wm.role, wm.joined_at
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE wm.workspace_id = $1 ORDER BY wm.joined_at ASC`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    ...toUser(row),
    role: row.role as WorkspaceRole,
    joinedAt: row.joined_at.toISOString(),
  }));
}

export async function getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const result = await getPool().query(`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [
    workspaceId,
    userId,
  ]);
  return (result.rows[0]?.role as WorkspaceRole | undefined) ?? null;
}

export async function setWorkspaceMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  await getPool().query(`UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [
    workspaceId,
    userId,
    role,
  ]);
}

export async function removeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const result = await getPool().query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
    workspaceId,
    userId,
  ]);
  return result.rowCount === 1;
}

// A personal integration is valid only while its owner belongs to this
// workspace. Removing a member must remove those credentials as part of the
// same transaction so a later invitation starts with no retained tools.
export async function removeWorkspaceMemberAndPersonalIntegrations(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
      workspaceId,
      userId,
    ]);
    if (membership.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      "DELETE FROM integrations WHERE workspace_id = $1 AND owner_user_id = $2 AND connection_scope = 'personal'",
      [workspaceId, userId],
    );
    // A removed member must not be able to rejoin immediately with an old
    // copied code. Rotation invalidates every previously shared join link.
    await client.query("UPDATE workspaces SET join_code = $2 WHERE id = $1", [workspaceId, generateJoinCode()]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
