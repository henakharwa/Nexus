-- Scope 11: workspace memory steers every agent reply, so a change made by a
-- non-Admin is held as a proposal until an Admin approves it. The live
-- workspace_memory table (the only one agents read) is untouched until then.
CREATE TABLE IF NOT EXISTS workspace_memory_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The entry an update or delete targets; NULL for a new entry. Deleting the
  -- entry closes its open proposals first (see deleteWorkspaceMemory) and
  -- keeps the reviewed ones as history.
  memory_id UUID REFERENCES workspace_memory(id) ON DELETE SET NULL,
  -- The entry a create proposal produced once approved.
  applied_memory_id UUID REFERENCES workspace_memory(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  kind TEXT NOT NULL DEFAULT 'knowledge' CHECK (kind IN ('knowledge', 'decision')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_title TEXT,
  source_url TEXT,
  fresh_until TIMESTAMPTZ,
  -- The entry's updated_at when the change was proposed, so an Admin cannot
  -- approve an edit that would silently overwrite a newer version.
  base_updated_at TIMESTAMPTZ,
  proposed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  review_note TEXT,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_memory_proposals_pending_idx
  ON workspace_memory_proposals (workspace_id, created_at DESC)
  WHERE status = 'pending';

-- One open proposal per member per entry keeps the review queue readable;
-- a member revises their pending change by withdrawing and re-proposing.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_memory_proposals_one_pending_per_entry
  ON workspace_memory_proposals (workspace_id, memory_id, proposed_by_user_id)
  WHERE status = 'pending' AND memory_id IS NOT NULL;
