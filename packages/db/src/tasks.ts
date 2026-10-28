// Workspace tasks.
import type {
  WorkspaceTask,
  WorkspaceTaskStatus } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";


// node-postgres parses a DATE column into a local-midnight Date; format it
// back to the calendar date that was stored (YYYY-MM-DD).
function calendarDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function toWorkspaceTask(row: Record<string, unknown>): WorkspaceTask {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), title: String(row.title), description: String(row.description ?? ""), status: row.status as WorkspaceTaskStatus,
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null, ownerName: row.owner_name ? String(row.owner_name) : null,
    dueDate: calendarDate(row.due_date), sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : null,
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null, createdByName: row.created_by_name ? String(row.created_by_name) : null,
    createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function listWorkspaceTasks(workspaceId: string): Promise<WorkspaceTask[]> {
  const result = await getPool().query(`SELECT t.*, owner.display_name AS owner_name, creator.display_name AS created_by_name
    FROM workspace_tasks t LEFT JOIN users owner ON owner.id=t.owner_user_id LEFT JOIN users creator ON creator.id=t.created_by_user_id
    WHERE t.workspace_id=$1 ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END, t.due_date NULLS LAST, t.updated_at DESC`, [workspaceId]);
  return result.rows.map(toWorkspaceTask);
}

export async function createWorkspaceTask(input: { workspaceId: string; title: string; description?: string; status?: WorkspaceTaskStatus; ownerUserId?: string | null; dueDate?: string | null; sourceConversationId?: string | null; createdByUserId: string }): Promise<WorkspaceTask> {
  const result = await getPool().query(`INSERT INTO workspace_tasks (workspace_id,title,description,owner_user_id,due_date,source_conversation_id,created_by_user_id,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'todo')) RETURNING *`, [input.workspaceId, input.title.trim(), input.description?.trim() ?? "", input.ownerUserId ?? null, input.dueDate ?? null, input.sourceConversationId ?? null, input.createdByUserId, input.status ?? null]);
  const row = result.rows[0];
  return toWorkspaceTask({ ...row, owner_name: null, created_by_name: null });
}

export async function updateWorkspaceTask(workspaceId: string, taskId: string, input: Partial<Pick<WorkspaceTask, "title" | "description" | "status" | "ownerUserId" | "dueDate" | "sourceConversationId">>): Promise<WorkspaceTask | null> {
  const current = (await getPool().query("SELECT * FROM workspace_tasks WHERE workspace_id=$1 AND id=$2", [workspaceId, taskId])).rows[0];
  if (!current) return null;
  // A key that is present (even as null) replaces the saved value, so owners
  // and due dates can be cleared; a missing key keeps the saved value.
  const merged = {
    title: input.title?.trim() || current.title,
    description: input.description?.trim() ?? current.description,
    status: input.status ?? current.status,
    ownerUserId: "ownerUserId" in input ? (input.ownerUserId ?? null) : current.owner_user_id,
    dueDate: "dueDate" in input ? (input.dueDate ?? null) : calendarDate(current.due_date),
    sourceConversationId: "sourceConversationId" in input ? (input.sourceConversationId ?? null) : current.source_conversation_id,
  };
  const result = await getPool().query(`UPDATE workspace_tasks SET title=$3,description=$4,status=$5,owner_user_id=$6,due_date=$7,source_conversation_id=$8,updated_at=now()
    WHERE workspace_id=$1 AND id=$2 RETURNING *`, [workspaceId, taskId, merged.title, merged.description, merged.status, merged.ownerUserId, merged.dueDate, merged.sourceConversationId]);
  return result.rows[0] ? toWorkspaceTask({ ...result.rows[0], owner_name: null, created_by_name: null }) : null;
}

export async function getWorkspaceTask(workspaceId: string, taskId: string): Promise<WorkspaceTask | null> {
  const result = await getPool().query(`SELECT t.*, owner.display_name AS owner_name, creator.display_name AS created_by_name
    FROM workspace_tasks t LEFT JOIN users owner ON owner.id=t.owner_user_id LEFT JOIN users creator ON creator.id=t.created_by_user_id
    WHERE t.workspace_id=$1 AND t.id=$2`, [workspaceId, taskId]);
  return result.rows[0] ? toWorkspaceTask(result.rows[0]) : null;
}

export async function deleteWorkspaceTask(workspaceId: string, taskId: string): Promise<WorkspaceTask | null> {
  const result = await getPool().query("DELETE FROM workspace_tasks WHERE workspace_id=$1 AND id=$2 RETURNING *", [workspaceId, taskId]);
  return result.rows[0] ? toWorkspaceTask({ ...result.rows[0], owner_name: null, created_by_name: null }) : null;
}
