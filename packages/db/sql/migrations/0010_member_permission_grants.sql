CREATE TABLE IF NOT EXISTS workspace_member_permission_grants (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, permission)
);

CREATE INDEX IF NOT EXISTS workspace_member_permission_grants_member
  ON workspace_member_permission_grants(workspace_id, user_id);
