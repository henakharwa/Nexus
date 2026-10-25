ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS join_approval_required BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS workspace_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_join_requests_one_pending
  ON workspace_join_requests(workspace_id, user_id) WHERE status = 'pending';
