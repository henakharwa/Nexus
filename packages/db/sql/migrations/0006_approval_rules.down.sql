DROP INDEX IF EXISTS pending_actions_pending_created_idx;
DROP TABLE IF EXISTS standing_approvals;
ALTER TABLE pending_actions DROP COLUMN IF EXISTS auto_approve_allowed;
DROP TABLE IF EXISTS pending_action_approvals;
ALTER TABLE pending_actions DROP COLUMN IF EXISTS auto_approved;
ALTER TABLE pending_actions DROP COLUMN IF EXISTS approval_rule_name;
ALTER TABLE pending_actions DROP COLUMN IF EXISTS approval_rule_id;
ALTER TABLE pending_actions DROP COLUMN IF EXISTS required_approvals;
DROP TABLE IF EXISTS approval_rules;
