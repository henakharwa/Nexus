-- Scope 14: per-workspace daily AI token budget. NULL uses the server
-- default (WORKSPACE_DAILY_TOKEN_BUDGET, 500,000 when unset).
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS daily_token_budget INTEGER
    CHECK (daily_token_budget IS NULL OR daily_token_budget > 0);

-- One row per workspace per UTC day: model tokens spent by chat replies,
-- workflow runs and AI drafts, so the budget can be enforced before a new
-- turn starts and shown in Observability.
CREATE TABLE IF NOT EXISTS workspace_token_usage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  tokens BIGINT NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  agent_turns INTEGER NOT NULL DEFAULT 0 CHECK (agent_turns >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, usage_date)
);
