-- Scope 9: limit workflow runs caused by a single GitHub repository.
ALTER TABLE workspace_workflow_runs
  ADD COLUMN IF NOT EXISTS source_repository TEXT;

CREATE INDEX IF NOT EXISTS workspace_workflow_runs_repository_started_idx
  ON workspace_workflow_runs (workspace_id, source_repository, started_at DESC)
  WHERE source_repository IS NOT NULL;

-- Scope 10: a public artifact link can expire and records only a total
-- view count. Neither value is exposed through the unauthenticated view.
ALTER TABLE workspace_artifacts
  ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS share_view_count INTEGER NOT NULL DEFAULT 0
    CHECK (share_view_count >= 0);

CREATE INDEX IF NOT EXISTS workspace_artifacts_active_share_expiry_idx
  ON workspace_artifacts (share_expires_at)
  WHERE share_token IS NOT NULL AND share_expires_at IS NOT NULL;
