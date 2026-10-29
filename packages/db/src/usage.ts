// Daily AI token budget per workspace (Security Validation scope 14).
import type { WorkspaceTokenBudget } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";

const FALLBACK_DAILY_TOKEN_BUDGET = 500_000;
/** The values an Admin can pick in Observability. */
export const DAILY_TOKEN_BUDGET_CHOICES = [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000] as const;

/** Server-wide default; WORKSPACE_DAILY_TOKEN_BUDGET overrides it. */
export function defaultDailyTokenBudget(): number {
  const configured = Number(process.env.WORKSPACE_DAILY_TOKEN_BUDGET);
  return Number.isInteger(configured) && configured > 0 ? configured : FALLBACK_DAILY_TOKEN_BUDGET;
}

/** Adds the tokens one agent turn (chat reply, workflow run or AI draft) spent today (UTC). */
export async function recordWorkspaceTokenUsage(workspaceId: string, tokens: number): Promise<void> {
  const spent = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
  await getPool().query(
    `INSERT INTO workspace_token_usage (workspace_id, usage_date, tokens, agent_turns)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2, 1)
     ON CONFLICT (workspace_id, usage_date)
     DO UPDATE SET tokens = workspace_token_usage.tokens + EXCLUDED.tokens,
                   agent_turns = workspace_token_usage.agent_turns + 1,
                   updated_at = now()`,
    [workspaceId, spent]
  );
}

export async function getWorkspaceTokenBudget(workspaceId: string): Promise<WorkspaceTokenBudget> {
  const result = await getPool().query(
    `SELECT w.daily_token_budget,
            (now() AT TIME ZONE 'UTC')::date AS today,
            COALESCE(json_agg(json_build_object('date', u.usage_date, 'tokens', u.tokens, 'agentTurns', u.agent_turns)
                     ORDER BY u.usage_date) FILTER (WHERE u.usage_date IS NOT NULL), '[]') AS days
     FROM workspaces w
     LEFT JOIN workspace_token_usage u
       ON u.workspace_id = w.id AND u.usage_date > (now() AT TIME ZONE 'UTC')::date - 7
     WHERE w.id = $1
     GROUP BY w.id`,
    [workspaceId]
  );
  const row = result.rows[0] ?? { daily_token_budget: null, days: [] };
  const defaultLimit = defaultDailyTokenBudget();
  const dailyLimit = row.daily_token_budget ? Number(row.daily_token_budget) : defaultLimit;
  const todayIso = new Date().toISOString().slice(0, 10);
  const days = (row.days as Array<{ date: string; tokens: number | string; agentTurns: number }>).map((day) => ({
    date: String(day.date).slice(0, 10),
    tokens: Number(day.tokens),
    agentTurns: Number(day.agentTurns),
  }));
  const today = days.find((day) => day.date === todayIso);
  const usedToday = today?.tokens ?? 0;
  const resetsAt = new Date(`${todayIso}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return {
    dailyLimit,
    defaultLimit,
    isCustom: Boolean(row.daily_token_budget),
    usedToday,
    agentTurnsToday: today?.agentTurns ?? 0,
    remaining: Math.max(0, dailyLimit - usedToday),
    exhausted: usedToday >= dailyLimit,
    resetsAt: resetsAt.toISOString(),
    recentDays: days,
    choices: [...DAILY_TOKEN_BUDGET_CHOICES],
  };
}

/** True while today's usage is below the workspace's daily budget. */
export async function hasWorkspaceTokenBudget(workspaceId: string): Promise<boolean> {
  return !(await getWorkspaceTokenBudget(workspaceId)).exhausted;
}

/** null returns the workspace to the server default. */
export async function setWorkspaceDailyTokenBudget(workspaceId: string, dailyLimit: number | null): Promise<WorkspaceTokenBudget> {
  await getPool().query("UPDATE workspaces SET daily_token_budget=$2 WHERE id=$1", [workspaceId, dailyLimit]);
  return getWorkspaceTokenBudget(workspaceId);
}
