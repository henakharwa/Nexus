-- Exactly what an agent-proposed action will change (a diff, full text, or
-- from -> to fields) and why it was proposed (the request and what the
-- agent read first), shown on the approval card. Built when the action is
-- proposed; see services/chat-server/src/change-preview.ts.
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS change_preview JSONB;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS proposal_context JSONB;
