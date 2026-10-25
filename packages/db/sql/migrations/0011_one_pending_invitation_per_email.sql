-- Keep one active invitation per workspace/email pair. Existing duplicates
-- came from the old client-side resend sequence, which created a new invite
-- before trying to remove the old one.
WITH ranked AS (
  SELECT
    token_hash,
    row_number() OVER (
      PARTITION BY workspace_id, email
      ORDER BY created_at DESC, token_hash DESC
    ) AS position
  FROM workspace_invitations
  WHERE accepted_at IS NULL
)
DELETE FROM workspace_invitations invitation
USING ranked
WHERE invitation.token_hash = ranked.token_hash
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_one_pending_email
  ON workspace_invitations (workspace_id, email)
  WHERE accepted_at IS NULL;
