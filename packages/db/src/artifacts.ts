// Artifacts, versions, comments, presence and public share links.
import { randomUUID } from "node:crypto";
import type {
  WorkspaceArtifact,
  WorkspaceArtifactComment,
  WorkspaceArtifactStatus,
  WorkspaceArtifactType,
  WorkspaceArtifactVersion,
  WorkspaceArtifactDashboard,
} from "@mai-chat/shared-types";
import { getPool } from "./pool.js";

import { getUserById } from "./users.js";

type ArtifactInput = {
  type: WorkspaceArtifactType;
  status: WorkspaceArtifactStatus;
  title: string;
  summary: string;
  content: string;
  ownerUserId: string | null;
  dashboardData?: WorkspaceArtifactDashboard | null;
  releaseVersion?: string | null;
};

function toWorkspaceArtifact(row: Record<string, unknown>): WorkspaceArtifact {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    type: row.type as WorkspaceArtifactType,
    status: row.status as WorkspaceArtifactStatus,
    title: String(row.title),
    summary: String(row.summary ?? ""),
    content: String(row.content),
    dashboardData:
      row.dashboard_data && typeof row.dashboard_data === "object"
        ? (row.dashboard_data as WorkspaceArtifactDashboard)
        : null,
    shareToken: row.share_token ? String(row.share_token) : null,
    shareExpiresAt: row.share_expires_at ? (row.share_expires_at as Date).toISOString() : null,
    shareViewCount: Number(row.share_view_count ?? 0),
    releaseVersion: row.release_version ? String(row.release_version) : null,
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    ownerName: row.owner_name ? String(row.owner_name) : null,
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdByName: row.created_by_name ? String(row.created_by_name) : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
function toWorkspaceArtifactComment(row: Record<string, unknown>): WorkspaceArtifactComment {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    workspaceId: String(row.workspace_id),
    content: String(row.content),
    authorUserId: row.author_user_id ? String(row.author_user_id) : null,
    authorName: row.author_name ? String(row.author_name) : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
const artifactSelect = `SELECT a.*, owner.display_name AS owner_name, creator.display_name AS created_by_name FROM workspace_artifacts a LEFT JOIN users owner ON owner.id=a.owner_user_id LEFT JOIN users creator ON creator.id=a.created_by_user_id`;
export async function listWorkspaceArtifacts(workspaceId: string): Promise<WorkspaceArtifact[]> {
  const result = await getPool().query(`${artifactSelect} WHERE a.workspace_id=$1 ORDER BY a.updated_at DESC`, [
    workspaceId,
  ]);
  return result.rows.map(toWorkspaceArtifact);
}
export async function getWorkspaceArtifact(workspaceId: string, artifactId: string): Promise<WorkspaceArtifact | null> {
  const result = await getPool().query(`${artifactSelect} WHERE a.workspace_id=$1 AND a.id=$2`, [
    workspaceId,
    artifactId,
  ]);
  return result.rows[0] ? toWorkspaceArtifact(result.rows[0]) : null;
}

/** Records a dashboard-view heartbeat shared by every server instance. */
export async function heartbeatArtifactPresence(
  workspaceId: string,
  artifactId: string,
  userId: string,
): Promise<{ userId: string; name: string }[]> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO workspace_artifact_presence (workspace_id, artifact_id, user_id, last_seen_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (artifact_id,user_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`,
    [workspaceId, artifactId, userId],
  );
  await pool.query("DELETE FROM workspace_artifact_presence WHERE last_seen_at < now() - interval '20 seconds'");
  const result = await pool.query(
    `SELECT presence.user_id, users.display_name
     FROM workspace_artifact_presence presence
     JOIN users ON users.id=presence.user_id
     WHERE presence.workspace_id=$1 AND presence.artifact_id=$2 AND presence.user_id<>$3
     ORDER BY presence.last_seen_at DESC`,
    [workspaceId, artifactId, userId],
  );
  return result.rows.map((row) => ({ userId: String(row.user_id), name: String(row.display_name) }));
}
export async function createWorkspaceArtifact(
  workspaceId: string,
  createdByUserId: string,
  input: ArtifactInput,
): Promise<WorkspaceArtifact> {
  const result = await getPool().query(
    `INSERT INTO workspace_artifacts (workspace_id,type,status,title,summary,content,dashboard_data,owner_user_id,created_by_user_id,release_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      workspaceId,
      input.type,
      input.status,
      input.title.trim(),
      input.summary.trim(),
      input.content.trim(),
      input.dashboardData ?? null,
      input.ownerUserId,
      createdByUserId,
      input.releaseVersion ?? null,
    ],
  );
  const artifact = (await getWorkspaceArtifact(workspaceId, String(result.rows[0].id)))!;
  await saveWorkspaceArtifactVersion(artifact, createdByUserId);
  return artifact;
}
export async function updateWorkspaceArtifact(
  workspaceId: string,
  artifactId: string,
  input: ArtifactInput,
  savedByUserId?: string,
): Promise<WorkspaceArtifact | null> {
  const result = await getPool().query(
    `UPDATE workspace_artifacts SET type=$3,status=$4,title=$5,summary=$6,content=$7,dashboard_data=$8,owner_user_id=$9,release_version=$10,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [
      workspaceId,
      artifactId,
      input.type,
      input.status,
      input.title.trim(),
      input.summary.trim(),
      input.content.trim(),
      input.dashboardData ?? null,
      input.ownerUserId,
      input.releaseVersion ?? null,
    ],
  );
  const artifact = result.rows[0] ? await getWorkspaceArtifact(workspaceId, artifactId) : null;
  if (artifact) await saveWorkspaceArtifactVersion(artifact, savedByUserId ?? null);
  return artifact;
}
export async function deleteWorkspaceArtifact(
  workspaceId: string,
  artifactId: string,
): Promise<WorkspaceArtifact | null> {
  const current = await getWorkspaceArtifact(workspaceId, artifactId);
  if (!current) return null;
  await getPool().query("DELETE FROM workspace_artifacts WHERE workspace_id=$1 AND id=$2", [workspaceId, artifactId]);
  return current;
}

// Generates (token === undefined) or revokes (token === null) a public
// read-only share link for a dashboard artifact. Generation happens here
// rather than in server.ts so the random token is a single round trip.
export async function setArtifactShareToken(
  workspaceId: string,
  artifactId: string,
  revoke: boolean,
  expiresAt: Date | null = null,
): Promise<WorkspaceArtifact | null> {
  const token = revoke ? null : randomUUID();
  const result = await getPool().query(
    `UPDATE workspace_artifacts
     SET share_token=$3, share_expires_at=$4,
         share_view_count=CASE WHEN $3 IS NULL THEN share_view_count ELSE 0 END
     WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [workspaceId, artifactId, token, revoke ? null : expiresAt],
  );
  return result.rows[0] ? getWorkspaceArtifact(workspaceId, artifactId) : null;
}

// Unauthenticated lookup for the public dashboard link -- deliberately
// returns only the safe subset (see PublicDashboardView), never the full
// WorkspaceArtifact, and only for a still-published dashboard (an
// artifact reverted to draft, archived, or deleted stops resolving even
// if someone still has the old link).
export async function getPublicDashboardByShareToken(
  token: string,
): Promise<import("@mai-chat/shared-types").PublicDashboardView | null> {
  const result = await getPool().query(
    `WITH shared AS (
       UPDATE workspace_artifacts
       SET share_view_count=share_view_count+1
       WHERE share_token=$1 AND type='dashboard' AND status='published'
         AND (share_expires_at IS NULL OR share_expires_at > now())
       RETURNING title, summary, dashboard_data, updated_at
     ) SELECT * FROM shared`,
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;
  // A dashboard shared before its first live refresh still has a working
  // link; it shows an empty snapshot until someone refreshes it.
  const dashboardData = row.dashboard_data ?? {
    health: "on_track",
    metrics: [],
    milestones: [],
    risks: [],
    decisions: [],
    checklist: [],
  };
  return {
    title: String(row.title),
    summary: String(row.summary ?? ""),
    dashboardData,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// Same idea as getPublicDashboardByShareToken above, for a published
// Release Notes artifact's share link.
export async function getPublicReleaseNotesByShareToken(
  token: string,
): Promise<import("@mai-chat/shared-types").PublicReleaseNotesView | null> {
  const result = await getPool().query(
    `WITH shared AS (
       UPDATE workspace_artifacts
       SET share_view_count=share_view_count+1
       WHERE share_token=$1 AND type='release_notes' AND status='published'
         AND (share_expires_at IS NULL OR share_expires_at > now())
       RETURNING title, summary, content, release_version, updated_at
     ) SELECT * FROM shared`,
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    title: String(row.title),
    summary: String(row.summary ?? ""),
    content: String(row.content),
    releaseVersion: row.release_version ? String(row.release_version) : null,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// Same idea, generalized to Plan / Report / Task list -- see
// PublicArtifactView's comment for why these three share one function
// while Dashboard and Release Notes keep their own.
export async function getPublicArtifactByShareToken(
  token: string,
): Promise<import("@mai-chat/shared-types").PublicArtifactView | null> {
  const result = await getPool().query(
    `WITH shared AS (
       UPDATE workspace_artifacts
       SET share_view_count=share_view_count+1
       WHERE share_token=$1 AND type IN ('plan', 'report', 'task_list') AND status='published'
         AND (share_expires_at IS NULL OR share_expires_at > now())
       RETURNING type, title, summary, content, updated_at
     ) SELECT * FROM shared`,
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    type: row.type,
    title: String(row.title),
    summary: String(row.summary ?? ""),
    content: String(row.content),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
export async function listWorkspaceArtifactComments(
  workspaceId: string,
  artifactId: string,
): Promise<WorkspaceArtifactComment[]> {
  const result = await getPool().query(
    "SELECT c.*, u.display_name AS author_name FROM workspace_artifact_comments c LEFT JOIN users u ON u.id=c.author_user_id WHERE c.workspace_id=$1 AND c.artifact_id=$2 ORDER BY c.created_at ASC",
    [workspaceId, artifactId],
  );
  return result.rows.map(toWorkspaceArtifactComment);
}
export async function createWorkspaceArtifactComment(
  workspaceId: string,
  artifactId: string,
  authorUserId: string,
  content: string,
): Promise<WorkspaceArtifactComment> {
  const result = await getPool().query(
    "INSERT INTO workspace_artifact_comments (workspace_id,artifact_id,author_user_id,content) VALUES ($1,$2,$3,$4) RETURNING *",
    [workspaceId, artifactId, authorUserId, content.trim()],
  );
  const comment = result.rows[0];
  const user = await getUserById(authorUserId);
  return { ...toWorkspaceArtifactComment(comment), authorName: user?.displayName ?? null };
}

function toWorkspaceArtifactVersion(row: Record<string, unknown>): WorkspaceArtifactVersion {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    content: String(row.content),
    dashboardData:
      row.dashboard_data && typeof row.dashboard_data === "object"
        ? (row.dashboard_data as WorkspaceArtifactDashboard)
        : null,
    status: row.status as WorkspaceArtifactStatus,
    savedByUserId: row.saved_by_user_id ? String(row.saved_by_user_id) : null,
    savedByName: row.saved_by_name ? String(row.saved_by_name) : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
async function saveWorkspaceArtifactVersion(artifact: WorkspaceArtifact, savedByUserId: string | null): Promise<void> {
  const result = await getPool().query(
    "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workspace_artifact_versions WHERE artifact_id=$1",
    [artifact.id],
  );
  await getPool().query(
    "INSERT INTO workspace_artifact_versions (artifact_id,workspace_id,version,title,summary,content,dashboard_data,status,saved_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      artifact.id,
      artifact.workspaceId,
      Number(result.rows[0].version),
      artifact.title,
      artifact.summary,
      artifact.content,
      artifact.dashboardData ?? null,
      artifact.status,
      savedByUserId,
    ],
  );
}
export async function listWorkspaceArtifactVersions(
  workspaceId: string,
  artifactId: string,
): Promise<WorkspaceArtifactVersion[]> {
  const result = await getPool().query(
    "SELECT v.*, u.display_name AS saved_by_name FROM workspace_artifact_versions v LEFT JOIN users u ON u.id=v.saved_by_user_id WHERE v.workspace_id=$1 AND v.artifact_id=$2 ORDER BY v.version DESC",
    [workspaceId, artifactId],
  );
  return result.rows.map(toWorkspaceArtifactVersion);
}
export async function restoreWorkspaceArtifactVersion(
  workspaceId: string,
  artifactId: string,
  versionId: string,
  savedByUserId: string,
): Promise<WorkspaceArtifact | null> {
  const result = await getPool().query(
    "SELECT * FROM workspace_artifact_versions WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3",
    [workspaceId, artifactId, versionId],
  );
  if (!result.rows[0]) return null;
  const version = toWorkspaceArtifactVersion(result.rows[0]);
  const current = await getWorkspaceArtifact(workspaceId, artifactId);
  if (!current) return null;
  return updateWorkspaceArtifact(
    workspaceId,
    artifactId,
    {
      type: current.type,
      status: version.status,
      title: version.title,
      summary: version.summary,
      content: version.content,
      dashboardData: current.dashboardData,
      ownerUserId: current.ownerUserId,
      releaseVersion: current.releaseVersion,
    },
    savedByUserId,
  );
}
