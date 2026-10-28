// Workspace memory entries and the agent memory context.
import type {
  WorkspaceMemory,
  WorkspaceMemoryKind,
  WorkspaceMemoryProposal,
  WorkspaceMemoryProposalAction,
  WorkspaceMemoryProposalStatus } from "@mai-chat/shared-types";
import type { PoolClient } from "pg";
import { getPool } from "./pool.js";

import { getUserById } from "./users.js";

function toWorkspaceMemory(row: Record<string, unknown>): WorkspaceMemory {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), kind: row.kind as WorkspaceMemoryKind, title: String(row.title), content: String(row.content),
    sourceTitle: row.source_title ? String(row.source_title) : null, sourceUrl: row.source_url ? String(row.source_url) : null,
    freshUntil: row.fresh_until ? (row.fresh_until as Date).toISOString() : null, createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdByName: row.created_by_name ? String(row.created_by_name) : null, createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function listWorkspaceMemory(workspaceId: string): Promise<WorkspaceMemory[]> {
  const result = await getPool().query(
    `SELECT m.*, u.display_name AS created_by_name FROM workspace_memory m LEFT JOIN users u ON u.id=m.created_by_user_id
     WHERE m.workspace_id=$1 ORDER BY m.updated_at DESC`, [workspaceId]
  );
  return result.rows.map(toWorkspaceMemory);
}

export async function createWorkspaceMemory(input: { workspaceId: string; kind: WorkspaceMemoryKind; title: string; content: string; sourceTitle?: string | null; sourceUrl?: string | null; freshUntil?: string | null; createdByUserId: string }): Promise<WorkspaceMemory> {
  const result = await getPool().query(
    `INSERT INTO workspace_memory (workspace_id,kind,title,content,source_title,source_url,fresh_until,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.workspaceId, input.kind, input.title.trim(), input.content.trim(), input.sourceTitle?.trim() || null, input.sourceUrl?.trim() || null, input.freshUntil || null, input.createdByUserId]
  );
  const memory = toWorkspaceMemory(result.rows[0]);
  const user = await getUserById(input.createdByUserId);
  return { ...memory, createdByName: user?.displayName ?? null };
}

export async function updateWorkspaceMemory(workspaceId: string, memoryId: string, input: { kind: WorkspaceMemoryKind; title: string; content: string; sourceTitle?: string | null; sourceUrl?: string | null; freshUntil?: string | null }): Promise<WorkspaceMemory | null> {
  const result = await getPool().query(
    `UPDATE workspace_memory SET kind=$3,title=$4,content=$5,source_title=$6,source_url=$7,fresh_until=$8,updated_at=now()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId, memoryId, input.kind, input.title.trim(), input.content.trim(), input.sourceTitle?.trim() || null, input.sourceUrl?.trim() || null, input.freshUntil || null]
  );
  if (!result.rows[0]) return null;
  const memory = toWorkspaceMemory(result.rows[0]);
  const user = memory.createdByUserId ? await getUserById(memory.createdByUserId) : null;
  return { ...memory, createdByName: user?.displayName ?? null };
}

export async function getWorkspaceMemory(workspaceId: string, memoryId: string): Promise<WorkspaceMemory | null> {
  const result = await getPool().query("SELECT * FROM workspace_memory WHERE workspace_id=$1 AND id=$2", [workspaceId, memoryId]);
  return result.rows[0] ? toWorkspaceMemory(result.rows[0]) : null;
}

export async function deleteWorkspaceMemory(workspaceId: string, memoryId: string): Promise<WorkspaceMemory | null> {
  return inTransaction(async (client) => {
    await closePendingProposalsFor(client, workspaceId, memoryId, "The entry was deleted.");
    const result = await client.query("DELETE FROM workspace_memory WHERE workspace_id=$1 AND id=$2 RETURNING *", [workspaceId, memoryId]);
    return result.rows[0] ? toWorkspaceMemory(result.rows[0]) : null;
  });
}

async function inTransaction<T>(task: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await task(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Open proposals against an entry that is about to disappear can no longer
// be applied; close them (keeping them as history) before the delete.
async function closePendingProposalsFor(client: PoolClient, workspaceId: string, memoryId: string, note: string): Promise<void> {
  await client.query(
    `UPDATE workspace_memory_proposals SET status='rejected', review_note=$3, reviewed_at=now()
     WHERE workspace_id=$1 AND memory_id=$2 AND status='pending'`,
    [workspaceId, memoryId, note]
  );
}

// ---------------------------------------------------------------------------
// Admin review of memory changes (Scope 11)
// ---------------------------------------------------------------------------

export type MemoryChangeInput = { kind: WorkspaceMemoryKind; title: string; content: string; sourceTitle?: string | null; sourceUrl?: string | null; freshUntil?: string | null };

const PROPOSAL_SELECT = `
  SELECT p.*, proposer.display_name AS proposed_by_name, reviewer.display_name AS reviewed_by_name,
         m.id AS current_id, m.workspace_id AS current_workspace_id, m.kind AS current_kind, m.title AS current_title,
         m.content AS current_content, m.source_title AS current_source_title, m.source_url AS current_source_url,
         m.fresh_until AS current_fresh_until, m.created_by_user_id AS current_created_by_user_id,
         m.created_at AS current_created_at, m.updated_at AS current_updated_at, creator.display_name AS current_created_by_name
  FROM workspace_memory_proposals p
  LEFT JOIN users proposer ON proposer.id = p.proposed_by_user_id
  LEFT JOIN users reviewer ON reviewer.id = p.reviewed_by_user_id
  LEFT JOIN workspace_memory m ON m.id = p.memory_id AND m.workspace_id = p.workspace_id
  LEFT JOIN users creator ON creator.id = m.created_by_user_id`;

function iso(value: unknown): string | null {
  return value ? (value as Date).toISOString() : null;
}

function toMemoryProposal(row: Record<string, unknown>): WorkspaceMemoryProposal {
  const current = row.current_id
    ? toWorkspaceMemory({
        id: row.current_id, workspace_id: row.current_workspace_id, kind: row.current_kind, title: row.current_title, content: row.current_content,
        source_title: row.current_source_title, source_url: row.current_source_url, fresh_until: row.current_fresh_until,
        created_by_user_id: row.current_created_by_user_id, created_by_name: row.current_created_by_name,
        created_at: row.current_created_at, updated_at: row.current_updated_at,
      })
    : null;
  const base = row.base_updated_at ? (row.base_updated_at as Date).getTime() : null;
  const outdated = row.status === "pending" && row.action !== "create" && (!current || (base !== null && new Date(current.updatedAt).getTime() > base));
  return {
    id: String(row.id), workspaceId: String(row.workspace_id),
    memoryId: row.memory_id ? String(row.memory_id) : null, appliedMemoryId: row.applied_memory_id ? String(row.applied_memory_id) : null,
    action: row.action as WorkspaceMemoryProposalAction, kind: row.kind as WorkspaceMemoryKind, title: String(row.title), content: String(row.content),
    sourceTitle: row.source_title ? String(row.source_title) : null, sourceUrl: row.source_url ? String(row.source_url) : null, freshUntil: iso(row.fresh_until),
    current, outdated,
    proposedByUserId: row.proposed_by_user_id ? String(row.proposed_by_user_id) : null, proposedByName: row.proposed_by_name ? String(row.proposed_by_name) : null,
    status: row.status as WorkspaceMemoryProposalStatus, reviewNote: row.review_note ? String(row.review_note) : null,
    reviewedByUserId: row.reviewed_by_user_id ? String(row.reviewed_by_user_id) : null, reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    reviewedAt: iso(row.reviewed_at), createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function getMemoryProposal(workspaceId: string, proposalId: string): Promise<WorkspaceMemoryProposal | null> {
  const result = await getPool().query(`${PROPOSAL_SELECT} WHERE p.workspace_id=$1 AND p.id=$2`, [workspaceId, proposalId]);
  return result.rows[0] ? toMemoryProposal(result.rows[0]) : null;
}

/** Pending proposals first, then the most recent decisions. Optionally one member's only. */
export async function listMemoryProposals(workspaceId: string, options: { status?: WorkspaceMemoryProposalStatus; proposedByUserId?: string; limit?: number } = {}): Promise<WorkspaceMemoryProposal[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const result = await getPool().query(
    `${PROPOSAL_SELECT}
     WHERE p.workspace_id=$1 AND ($2::text IS NULL OR p.status=$2) AND ($3::uuid IS NULL OR p.proposed_by_user_id=$3)
     ORDER BY (p.status='pending') DESC, COALESCE(p.reviewed_at, p.created_at) DESC
     LIMIT $4`,
    [workspaceId, options.status ?? null, options.proposedByUserId ?? null, limit]
  );
  return result.rows.map(toMemoryProposal);
}

export async function countPendingMemoryProposals(workspaceId: string): Promise<number> {
  const result = await getPool().query("SELECT count(*)::int AS n FROM workspace_memory_proposals WHERE workspace_id=$1 AND status='pending'", [workspaceId]);
  return Number(result.rows[0]?.n ?? 0);
}

export type CreateMemoryProposalResult =
  | { ok: true; proposal: WorkspaceMemoryProposal }
  | { ok: false; reason: "not_found" | "duplicate" };

/**
 * Records a proposed create, update or delete. Update and delete proposals
 * snapshot the entry's current version so a later edit makes them outdated.
 */
export async function createMemoryProposal(input: { workspaceId: string; action: WorkspaceMemoryProposalAction; memoryId?: string | null; change?: MemoryChangeInput; proposedByUserId: string }): Promise<CreateMemoryProposalResult> {
  let target: WorkspaceMemory | null = null;
  if (input.action !== "create") {
    target = input.memoryId ? await getWorkspaceMemory(input.workspaceId, input.memoryId) : null;
    if (!target) return { ok: false, reason: "not_found" };
  }
  // A delete proposal carries the entry's current text so the review queue
  // and the audit trail show what would be removed.
  const change: MemoryChangeInput = input.action === "delete" || !input.change
    ? { kind: target!.kind, title: target!.title, content: target!.content, sourceTitle: target!.sourceTitle, sourceUrl: target!.sourceUrl, freshUntil: target!.freshUntil }
    : input.change;
  try {
    const result = await getPool().query(
      `INSERT INTO workspace_memory_proposals
         (workspace_id, memory_id, action, kind, title, content, source_title, source_url, fresh_until, base_updated_at, proposed_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [input.workspaceId, target?.id ?? null, input.action, change.kind, change.title.trim(), change.content.trim(),
        change.sourceTitle?.trim() || null, change.sourceUrl?.trim() || null, change.freshUntil || null, target?.updatedAt ?? null, input.proposedByUserId]
    );
    return { ok: true, proposal: (await getMemoryProposal(input.workspaceId, String(result.rows[0].id)))! };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return { ok: false, reason: "duplicate" };
    throw error;
  }
}

export type ReviewMemoryProposalResult =
  | { ok: true; proposal: WorkspaceMemoryProposal; memory: WorkspaceMemory | null }
  | { ok: false; reason: "not_found" | "not_pending" | "outdated" | "self_review" };

/**
 * Approves (and applies) or rejects a pending proposal in one transaction.
 * The proposal row is locked so two Admins cannot both act on it, and an
 * update or delete is refused when the entry changed after it was proposed.
 */
export async function reviewMemoryProposal(input: { workspaceId: string; proposalId: string; decision: "approve" | "reject"; reviewerUserId: string; note?: string | null }): Promise<ReviewMemoryProposalResult> {
  const outcome = await inTransaction<ReviewMemoryProposalResult | { ok: true; memoryId: string | null; deleted: WorkspaceMemory | null }>(async (client) => {
    const found = await client.query("SELECT * FROM workspace_memory_proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [input.workspaceId, input.proposalId]);
    const row = found.rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    if (row.status !== "pending") return { ok: false, reason: "not_pending" };
    if (row.proposed_by_user_id && String(row.proposed_by_user_id) === input.reviewerUserId) return { ok: false, reason: "self_review" };
    const note = input.note?.trim().slice(0, 500) || null;
    if (input.decision === "reject") {
      await client.query(
        "UPDATE workspace_memory_proposals SET status='rejected', review_note=$3, reviewed_by_user_id=$4, reviewed_at=now() WHERE workspace_id=$1 AND id=$2",
        [input.workspaceId, input.proposalId, note, input.reviewerUserId]
      );
      return { ok: true, memoryId: row.memory_id ? String(row.memory_id) : null, deleted: null };
    }
    let memoryId: string | null = row.memory_id ? String(row.memory_id) : null;
    let deleted: WorkspaceMemory | null = null;
    if (row.action === "create") {
      const created = await client.query(
        `INSERT INTO workspace_memory (workspace_id,kind,title,content,source_title,source_url,fresh_until,created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [input.workspaceId, row.kind, row.title, row.content, row.source_title, row.source_url, row.fresh_until, row.proposed_by_user_id]
      );
      memoryId = String(created.rows[0].id);
    } else {
      const current = await client.query("SELECT * FROM workspace_memory WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [input.workspaceId, memoryId]);
      const live = current.rows[0];
      if (!live || (row.base_updated_at && (live.updated_at as Date).getTime() > (row.base_updated_at as Date).getTime())) {
        return { ok: false, reason: "outdated" };
      }
      if (row.action === "update") {
        await client.query(
          `UPDATE workspace_memory SET kind=$3,title=$4,content=$5,source_title=$6,source_url=$7,fresh_until=$8,updated_at=now()
           WHERE workspace_id=$1 AND id=$2`,
          [input.workspaceId, memoryId, row.kind, row.title, row.content, row.source_title, row.source_url, row.fresh_until]
        );
      } else {
        deleted = toWorkspaceMemory(live);
      }
    }
    await client.query(
      `UPDATE workspace_memory_proposals SET status='approved', review_note=$3, reviewed_by_user_id=$4, reviewed_at=now(),
         applied_memory_id=CASE WHEN action='create' THEN $5::uuid ELSE applied_memory_id END
       WHERE workspace_id=$1 AND id=$2`,
      [input.workspaceId, input.proposalId, note, input.reviewerUserId, row.action === "create" ? memoryId : null]
    );
    if (row.action === "delete" && memoryId) {
      // Other members' open proposals for this entry can no longer apply.
      await closePendingProposalsFor(client, input.workspaceId, memoryId, "The entry was deleted.");
      await client.query("DELETE FROM workspace_memory WHERE workspace_id=$1 AND id=$2", [input.workspaceId, memoryId]);
    }
    return { ok: true, memoryId, deleted };
  });
  if (!outcome.ok) return outcome;
  const proposal = (await getMemoryProposal(input.workspaceId, input.proposalId))!;
  if ("deleted" in outcome && outcome.deleted) return { ok: true, proposal, memory: outcome.deleted };
  const memoryId = "memoryId" in outcome ? outcome.memoryId : null;
  if (input.decision === "reject" || !memoryId) return { ok: true, proposal, memory: null };
  const memory = await getWorkspaceMemory(input.workspaceId, memoryId);
  const creator = memory?.createdByUserId ? await getUserById(memory.createdByUserId) : null;
  return { ok: true, proposal, memory: memory ? { ...memory, createdByName: creator?.displayName ?? null } : null };
}

/** The proposer takes back their own pending change. */
export async function withdrawMemoryProposal(workspaceId: string, proposalId: string, userId: string): Promise<WorkspaceMemoryProposal | null> {
  const result = await getPool().query(
    `UPDATE workspace_memory_proposals SET status='withdrawn', reviewed_at=now()
     WHERE workspace_id=$1 AND id=$2 AND proposed_by_user_id=$3 AND status='pending' RETURNING id`,
    [workspaceId, proposalId, userId]
  );
  return result.rows[0] ? getMemoryProposal(workspaceId, proposalId) : null;
}

export async function workspaceMemoryContext(workspaceId: string, limit = 12): Promise<string> {
  return formatWorkspaceMemoryContext(await listWorkspaceMemory(workspaceId), limit);
}

/** Formats durable memories for an agent turn without reading another workspace. */
export function formatWorkspaceMemoryContext(memories: WorkspaceMemory[], limit = 12): string {
  const selected = memories.slice(0, limit);
  if (!selected.length) return "";
  return selected.map((memory) => {
    const stale = memory.freshUntil && new Date(memory.freshUntil).getTime() < Date.now() ? "STALE — verify before relying on it" : memory.freshUntil ? `current through ${memory.freshUntil.slice(0, 10)}` : "no freshness date";
    const source = memory.sourceTitle ? ` Source: ${memory.sourceTitle}${memory.sourceUrl ? ` (${memory.sourceUrl})` : ""}.` : "";
    return `[Memory: ${memory.title}] (${memory.kind}; ${stale})\n${memory.content}${source}`;
  }).join("\n\n").slice(0, 12_000);
}
