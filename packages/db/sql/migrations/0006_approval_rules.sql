-- Approval rules: Admin-defined policy for agent-proposed writes.
-- Each rule matches on tool, action type, repository, branch and Slack
-- channel, and either auto-approves, requires N approvals from people other
-- than the requester, or blocks the action. When several rules match, the
-- strictest one wins (services/chat-server/src/approval-rules.ts).
CREATE TABLE IF NOT EXISTS approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- NULL matches every tool.
  provider TEXT CHECK (provider IN ('github', 'slack', 'linear', 'notion', 'figma')),
  -- Empty matches every action type.
  categories TEXT[] NOT NULL DEFAULT '{}',
  -- Comma-separated glob patterns ("acme/*", "main, release/*"). NULL matches everything.
  repo_pattern TEXT,
  branch_pattern TEXT,
  channel_pattern TEXT,
  effect TEXT NOT NULL CHECK (effect IN ('auto_approve', 'require_approvals', 'block')),
  required_approvals INT CHECK (required_approvals BETWEEN 1 AND 5),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effect <> 'require_approvals' OR required_approvals IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS approval_rules_workspace_idx ON approval_rules (workspace_id, created_at);

-- What the rules decided when the action was proposed. The rule id is not a
-- foreign key: deleting a rule keeps the name on actions it governed.
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS required_approvals INT NOT NULL DEFAULT 1;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS approval_rule_id UUID;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS approval_rule_name TEXT;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN NOT NULL DEFAULT false;
-- False for actions from workflows marked "Requires approval": no rule or
-- standing approval may approve them without a person.
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS auto_approve_allowed BOOLEAN NOT NULL DEFAULT true;

-- One row per person who approved an action that needs more than one approval.
CREATE TABLE IF NOT EXISTS pending_action_approvals (
  action_id UUID NOT NULL REFERENCES pending_actions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, user_id)
);

-- Standing approvals: an approver says "approve this kind of action for this
-- target for 7 days" from an approval card. They apply only where no rule
-- asks for more than a normal approval card, and they can be revoked.
CREATE TABLE IF NOT EXISTS standing_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  -- What it covers, e.g. "github:acme/web" or "slack:c0123"; scope_label is how it's shown.
  scope TEXT NOT NULL,
  scope_label TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL,
  source_action_id UUID REFERENCES pending_actions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_name TEXT
);
CREATE INDEX IF NOT EXISTS standing_approvals_lookup_idx ON standing_approvals (workspace_id, provider, tool_name, scope);
-- Pending actions waiting past the expiry window are swept on a timer.
CREATE INDEX IF NOT EXISTS pending_actions_pending_created_idx ON pending_actions (created_at) WHERE status = 'pending';
