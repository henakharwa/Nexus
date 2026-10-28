// Workspace tasks. Every create, change and delete is written to the
// activity log (Security Validation scope 11) so the board has an
// attributable history like every other shared object.
import * as db from "@mai-chat/db";
import type { WorkspaceTask } from "@mai-chat/shared-types";
import { UUID_RE, paramString } from "../http-utils.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerTasksRoutes({ app, requireRole }: RouteContext): void {
  const taskStatuses = ["todo", "in_progress", "review", "done"] as const;
  const TASK_TITLE_MAX = 200;
  // A real calendar day in YYYY-MM-DD form (rejects 2026-02-31).
  function isCalendarDate(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  // Reads only the fields the request sent, so a PATCH can change one field
  // or clear an owner / due date (null or "") without touching the rest.
  function taskInput(body: Record<string, unknown>) {
    const input: { title?: string; description?: string; status?: (typeof taskStatuses)[number]; ownerUserId?: string | null; dueDate?: string | null; sourceConversationId?: string | null } = {};
    if (typeof body.title === "string") input.title = body.title;
    if (typeof body.description === "string") input.description = body.description;
    if (taskStatuses.includes(body.status as (typeof taskStatuses)[number])) input.status = body.status as (typeof taskStatuses)[number];
    if ("ownerUserId" in body) input.ownerUserId = typeof body.ownerUserId === "string" && UUID_RE.test(body.ownerUserId) ? body.ownerUserId : null;
    if ("dueDate" in body) input.dueDate = isCalendarDate(body.dueDate) ? body.dueDate : null;
    if ("sourceConversationId" in body) input.sourceConversationId = typeof body.sourceConversationId === "string" && UUID_RE.test(body.sourceConversationId) ? body.sourceConversationId : null;
    return input;
  }
  async function taskInputError(workspaceId: string, body: Record<string, unknown>, input: ReturnType<typeof taskInput>): Promise<string | null> {
    if (input.title !== undefined && input.title.trim().length > TASK_TITLE_MAX) return `Task titles can be up to ${TASK_TITLE_MAX} characters.`;
    if (body.status !== undefined && input.status === undefined) return "Status must be todo, in_progress, review or done.";
    if (typeof body.dueDate === "string" && body.dueDate && input.dueDate === null) return "Due date must be a valid YYYY-MM-DD date.";
    if (input.ownerUserId && !(await db.getWorkspaceRole(workspaceId, input.ownerUserId))) return "Task owner must be a workspace member.";
    return null;
  }
  const STATUS_LABELS: Record<(typeof taskStatuses)[number], string> = { todo: "To do", in_progress: "In progress", review: "Review", done: "Done" };
  async function memberName(workspaceId: string, userId: string | null): Promise<string> {
    if (!userId) return "nobody";
    const member = (await db.listWorkspaceMembersWithRoles(workspaceId)).find((m) => m.id === userId);
    return member?.displayName ?? "a former member";
  }
  // Names each field that actually changed, with before/after values for the
  // short ones. Description text is not copied into the log, only flagged.
  async function describeTaskChanges(before: WorkspaceTask, after: WorkspaceTask) {
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    const phrases: string[] = [];
    if (before.title !== after.title) {
      changes.title = { from: before.title, to: after.title };
      phrases.push(`renamed it from "${before.title}"`);
    }
    if (before.status !== after.status) {
      changes.status = { from: before.status, to: after.status };
      phrases.push(`moved it from ${STATUS_LABELS[before.status]} to ${STATUS_LABELS[after.status]}`);
    }
    if (before.ownerUserId !== after.ownerUserId) {
      changes.owner = { from: before.ownerUserId, to: after.ownerUserId };
      phrases.push(after.ownerUserId ? `assigned it to ${await memberName(after.workspaceId, after.ownerUserId)}` : "removed the owner");
    }
    if (before.dueDate !== after.dueDate) {
      changes.dueDate = { from: before.dueDate, to: after.dueDate };
      phrases.push(after.dueDate ? `set the due date to ${after.dueDate}` : "cleared the due date");
    }
    if (before.description !== after.description) {
      changes.description = { from: null, to: null };
      phrases.push("edited the description");
    }
    if (before.sourceConversationId !== after.sourceConversationId) {
      changes.sourceConversation = { from: before.sourceConversationId, to: after.sourceConversationId };
      phrases.push("changed the linked conversation");
    }
    return { changes, phrases };
  }
  async function recordTaskEvent(req: Request, eventType: "task.created" | "task.updated" | "task.deleted", task: WorkspaceTask, summary: string, metadata: Record<string, unknown> = {}) {
    await db.recordAuditEvent({
      workspaceId: task.workspaceId,
      eventType,
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary,
      metadata: { taskId: task.id, taskTitle: task.title, status: task.status, ...metadata },
    });
  }
  app.get("/workspaces/:id/tasks", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceTasks(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/tasks", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const body = req.body ?? {};
    const input = taskInput(body);
    if (!input.title?.trim()) return res.status(400).json({ error: "A task title is required." });
    const invalid = await taskInputError(paramString(req.params.id), body, input);
    if (invalid) return res.status(400).json({ error: invalid });
    const task = await db.createWorkspaceTask({ workspaceId: paramString(req.params.id), ...input, title: input.title, createdByUserId: req.user!.id });
    const owner = task.ownerUserId ? ` for ${await memberName(task.workspaceId, task.ownerUserId)}` : "";
    await recordTaskEvent(req, "task.created", task, `${req.user!.displayName} created task ${task.title} in ${STATUS_LABELS[task.status]}${owner}`, { ownerUserId: task.ownerUserId, dueDate: task.dueDate });
    res.status(201).json(task);
  });
  app.patch("/workspaces/:id/tasks/:taskId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const body = req.body ?? {};
    const input = taskInput(body);
    if (input.title !== undefined && !input.title.trim()) return res.status(400).json({ error: "A task title is required." });
    const invalid = await taskInputError(paramString(req.params.id), body, input);
    if (invalid) return res.status(400).json({ error: invalid });
    const before = await db.getWorkspaceTask(paramString(req.params.id), paramString(req.params.taskId));
    if (!before) return res.status(404).json({ error: "Task not found." });
    const task = await db.updateWorkspaceTask(paramString(req.params.id), paramString(req.params.taskId), input);
    if (!task) return res.status(404).json({ error: "Task not found." });
    const { changes, phrases } = await describeTaskChanges(before, task);
    // A save that changed nothing (e.g. dropping a card back in its column)
    // is not activity worth logging.
    if (phrases.length) {
      await recordTaskEvent(req, "task.updated", task, `${req.user!.displayName} updated task ${task.title}: ${phrases.join(", ")}`, { changes });
    }
    res.json(task);
  });
  app.delete("/workspaces/:id/tasks/:taskId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const task = await db.deleteWorkspaceTask(paramString(req.params.id), paramString(req.params.taskId));
    if (!task) return res.status(404).json({ error: "Task not found." });
    await recordTaskEvent(req, "task.deleted", task, `${req.user!.displayName} deleted task ${task.title} (was in ${STATUS_LABELS[task.status]})`);
    res.status(204).end();
  });
}
