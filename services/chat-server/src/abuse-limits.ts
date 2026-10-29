// Abuse and cost limits (Security Validation scope 14).
//
// Each limit is a fixed window counted in the database (auth_rate_limits),
// so it holds across restarts and across several chat-server processes.
// Every number can be raised or lowered with the environment variable named
// next to it, without a code change.
import * as db from "@mai-chat/db";
import type { Response } from "express";

export interface AbuseLimit {
  scope: string;
  env: string;
  defaultMax: number;
  windowSeconds: number;
  /** Finishes "You've reached the limit for ..." */
  what: string;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export const ABUSE_LIMITS = {
  /** New workspaces a person can create. */
  workspaceCreate: { scope: "workspace-create-user", env: "WORKSPACES_PER_USER_PER_DAY", defaultMax: 10, windowSeconds: DAY, what: "creating workspaces today" },
  /** New agent drafts a person can create. */
  agentCreate: { scope: "agent-create-user", env: "AGENTS_PER_USER_PER_HOUR", defaultMax: 20, windowSeconds: HOUR, what: "creating agents this hour" },
  /** Invitation emails one workspace can send (stops it being used as a spam relay). */
  inviteWorkspace: { scope: "invite-workspace", env: "INVITES_PER_WORKSPACE_PER_HOUR", defaultMax: 20, windowSeconds: HOUR, what: "invitations from this workspace this hour" },
  /** Invitation emails one person can send across all their workspaces. */
  inviteUser: { scope: "invite-user", env: "INVITES_PER_USER_PER_DAY", defaultMax: 50, windowSeconds: DAY, what: "sending invitations today" },
  /** AI drafts, reports, release notes and dashboard refreshes a person can generate. */
  aiGenerate: { scope: "ai-generate-user", env: "AI_GENERATIONS_PER_USER_PER_HOUR", defaultMax: 20, windowSeconds: HOUR, what: "AI drafts and generated reports this hour" },
  /** Manual workflow runs a person can start (on top of the workspace's hourly run quota). */
  workflowRun: { scope: "workflow-run-user", env: "WORKFLOW_RUNS_PER_USER_PER_HOUR", defaultMax: 20, windowSeconds: HOUR, what: "manual workflow runs this hour" },
} satisfies Record<string, AbuseLimit>;

export function limitMax(limit: AbuseLimit): number {
  const configured = Number(process.env[limit.env]);
  return Number.isInteger(configured) && configured > 0 ? configured : limit.defaultMax;
}

export function describeWait(seconds: number): string {
  if (seconds < 90) return "in a minute";
  if (seconds < 90 * 60) return `in ${Math.ceil(seconds / 60)} minutes`;
  return `in about ${Math.ceil(seconds / 3600)} hours`;
}

/**
 * Counts one attempt for `subject`. When the limit is reached it answers
 * 429 with a Retry-After header and a readable message, and returns false.
 */
export async function enforceAbuseLimit(res: Response, limit: AbuseLimit, subject: string): Promise<boolean> {
  const max = limitMax(limit);
  const { allowed, retryAfterSeconds } = await db.takeRateLimit(limit.scope, subject, max, limit.windowSeconds);
  if (allowed) return true;
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: `You've reached the limit for ${limit.what} (${max}). Try again ${describeWait(retryAfterSeconds)}.`,
    code: "rate_limited",
    retryAfterSeconds,
  });
  return false;
}

/** The message shown when a workspace has used its daily AI token budget. */
export function tokenBudgetExhaustedMessage(budget: { dailyLimit: number; resetsAt: string }): string {
  const hours = Math.max(1, Math.ceil((new Date(budget.resetsAt).getTime() - Date.now()) / 3_600_000));
  return `This workspace has used its daily AI budget of ${budget.dailyLimit.toLocaleString("en-US")} tokens. It resets at midnight UTC (in about ${hours} hour${hours === 1 ? "" : "s"}). An Admin can raise it on the Observability page.`;
}

/** Answers 429 and returns false when the workspace's daily token budget is used up. */
export async function enforceTokenBudget(res: Response, workspaceId: string): Promise<boolean> {
  const budget = await db.getWorkspaceTokenBudget(workspaceId);
  if (!budget.exhausted) return true;
  const retryAfterSeconds = Math.max(1, Math.ceil((new Date(budget.resetsAt).getTime() - Date.now()) / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: tokenBudgetExhaustedMessage(budget), code: "token_budget_exhausted", retryAfterSeconds });
  return false;
}
