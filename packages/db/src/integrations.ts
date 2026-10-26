// Provider connections and encrypted credentials.
import type {
  GithubIntegrationConfig,
  IntegrationConfig,
  SlackIntegrationConfig } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";
import { encryptToken, decryptToken, needsTokenReencryption } from "./crypto.js";


export async function upsertGithubIntegration(input: {
  workspaceId: string;
  owner: string;
  repo: string;
  token: string;
  connectionName?: string;
  connectionScope?: "shared" | "personal";
  ownerUserId?: string;
}): Promise<GithubIntegrationConfig> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  const connectionName = input.connectionName?.trim() || "Shared connection";
  const connectionScope = input.connectionScope ?? "shared";
  const accountKey = connectionScope === "personal" ? `personal:${input.ownerUserId}:${connectionName}` : connectionName === "Shared connection" ? "shared" : `shared:${connectionName}`;
  const result = await pool.query(
    `INSERT INTO integrations (workspace_id, type, owner, repo, encrypted_token, connection_name, connection_scope, owner_user_id, account_key)
     VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, type, account_key)
     DO UPDATE SET owner = $2, repo = $3, encrypted_token = $4, connection_name = $5, connected_at = now()
     RETURNING id, workspace_id, connection_name, connection_scope, owner_user_id, connected_at`,
    [input.workspaceId, input.owner, input.repo, encrypted, connectionName, connectionScope, input.ownerUserId ?? null, accountKey]
  );
  return {
    id: result.rows[0].id,
    type: "github",
    workspaceId: result.rows[0].workspace_id,
    connectionName: result.rows[0].connection_name,
    connectionScope: result.rows[0].connection_scope,
    ownerUserId: result.rows[0].owner_user_id ?? undefined,
    owner: input.owner,
    repo: input.repo,
    connected: true,
    connectedAt: result.rows[0].connected_at.toISOString(),
  };
}

// GitHub OAuth login (services/chat-server/src/github-oauth.ts) lands here
// first, before any repo is chosen -- owner/repo are left as whatever they
// already were (NULL on a first-ever connect), never overwritten with a
// guess. Distinct from upsertGithubIntegration, which is the pasted-token
// flow and always sets owner+repo+token together in one step.
export async function saveGithubOAuthToken(input: { workspaceId: string; token: string; ownerUserId?: string; accountLogin?: string | null }): Promise<void> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  const accountKey = input.ownerUserId ? `personal:${input.ownerUserId}:github` : "shared";
  const connectionScope = input.ownerUserId ? "personal" : "shared";
  await pool.query(
    `INSERT INTO integrations (workspace_id, type, encrypted_token, connection_scope, owner_user_id, account_key, account_login)
     VALUES ($1, 'github', $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, type, account_key)
     DO UPDATE SET encrypted_token = $2, connection_scope = $3, owner_user_id = $4, account_login = COALESCE($6, integrations.account_login), connected_at = now()`,
    [input.workspaceId, encrypted, connectionScope, input.ownerUserId ?? null, accountKey, input.accountLogin ?? null]
  );
}

// Attaches/changes which repo a workspace's already-connected GitHub token
// should be used against (the repo-picker step after OAuth login, or
// "change repository" later). Returns null if there's no GitHub
// integration row yet for this workspace -- the caller must have already
// connected a token (OAuth or pasted) before a repo can be chosen.
export async function setGithubRepo(input: { workspaceId: string; owner: string; repo: string; ownerUserId?: string }): Promise<GithubIntegrationConfig | null> {
  const pool = getPool();
  const accountKey = input.ownerUserId ? `personal:${input.ownerUserId}:github` : "shared";
  const result = await pool.query(
    `UPDATE integrations SET owner = $2, repo = $3
     WHERE workspace_id = $1 AND type = 'github' AND account_key = $4
     RETURNING id, workspace_id, connection_name, connection_scope, owner_user_id, owner, repo, connected_at`,
    [input.workspaceId, input.owner, input.repo, accountKey]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    type: "github",
    workspaceId: row.workspace_id,
    connectionName: row.connection_name,
    connectionScope: row.connection_scope,
    ownerUserId: row.owner_user_id ?? undefined,
    owner: row.owner,
    repo: row.repo,
    connected: true,
    connectedAt: row.connected_at.toISOString(),
  };
}

export async function upsertSlackIntegration(input: {
  workspaceId: string;
  teamName: string;
  token: string;
  ownerUserId?: string;
}): Promise<SlackIntegrationConfig> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  // A Slack OAuth grant is a user token, so it must remain attributable to
  // the member who authorized it. This also gives each member an independent
  // Slack connection within the same workspace.
  const accountKey = input.ownerUserId ? `personal:${input.ownerUserId}:slack` : "shared";
  const connectionScope = input.ownerUserId ? "personal" : "shared";
  const result = await pool.query(
    `INSERT INTO integrations (workspace_id, type, team_name, encrypted_token, connection_scope, owner_user_id, account_key)
     VALUES ($1, 'slack', $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, type, account_key)
     DO UPDATE SET team_name = $2, encrypted_token = $3, connection_scope = $4, owner_user_id = $5, connected_at = now()
     RETURNING id, workspace_id, connection_name, connection_scope, owner_user_id, connected_at`,
    [input.workspaceId, input.teamName, encrypted, connectionScope, input.ownerUserId ?? null, accountKey]
  );
  return {
    id: result.rows[0].id,
    type: "slack",
    workspaceId: result.rows[0].workspace_id,
    connectionName: result.rows[0].connection_name,
    connectionScope: result.rows[0].connection_scope,
    ownerUserId: result.rows[0].owner_user_id ?? undefined,
    teamName: input.teamName,
    connected: true,
    connectedAt: result.rows[0].connected_at.toISOString(),
  };
}

// Each remote-provider account belongs to the workspace member who connected it.
export async function upsertRemoteMcpIntegration(input: { workspaceId: string; type: "linear" | "notion" | "figma"; endpoint: string; token: string; ownerUserId: string; accountName?: string }): Promise<import("@mai-chat/shared-types").RemoteMcpIntegrationConfig> {
  const accountKey = `personal:${input.ownerUserId}:${input.type}`;
  const result = await getPool().query(
    `INSERT INTO integrations (workspace_id, type, owner, team_name, encrypted_token, connection_name, connection_scope, owner_user_id, account_key) VALUES ($1, $2, $3, $4, $5, $6, 'personal', $7, $8)
     ON CONFLICT (workspace_id, type, account_key) DO UPDATE SET owner = $3, team_name = $4, encrypted_token = $5, connection_name = $6, connection_scope = 'personal', owner_user_id = $7, connected_at = now()
     RETURNING id, workspace_id, type, connection_name, connection_scope, owner_user_id, owner, team_name, connected_at`,
    [input.workspaceId, input.type, input.endpoint, input.accountName ?? null, encryptToken(input.token), input.accountName?.trim() || `My ${input.type[0].toUpperCase()}${input.type.slice(1)}`, input.ownerUserId, accountKey]
  );
  const row = result.rows[0];
  return { id: row.id, type: row.type, workspaceId: row.workspace_id, connectionName: row.connection_name, connectionScope: row.connection_scope, ownerUserId: row.owner_user_id, endpoint: row.owner, accountName: row.team_name ?? undefined, connected: true, connectedAt: row.connected_at.toISOString() };
}

// Client-safe listing -- never includes the decrypted token.
export async function listIntegrations(workspaceId: string): Promise<IntegrationConfig[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT i.id, i.type, i.owner, i.repo, i.team_name, i.connection_name, i.connection_scope, i.owner_user_id, i.connected_at, i.account_login, u.display_name AS connected_by_name
     FROM integrations i LEFT JOIN users u ON u.id = i.owner_user_id WHERE i.workspace_id = $1`,
    [workspaceId]
  );
  return result.rows.map((row): IntegrationConfig => {
    if (row.type === "github") {
      return {
        id: row.id,
        type: "github",
        workspaceId,
        connectionName: row.connection_name,
        connectionScope: row.connection_scope,
        ownerUserId: row.owner_user_id ?? undefined,
        connectedByName: row.connected_by_name ?? undefined,
        owner: row.owner ?? undefined,
        repo: row.repo ?? undefined,
        accountLogin: row.account_login ?? undefined,
        connected: true,
        connectedAt: row.connected_at.toISOString(),
      };
    }
    if (row.type === "slack") return {
      id: row.id,
      type: "slack",
      workspaceId,
      connectionName: row.connection_name,
      connectionScope: row.connection_scope,
      ownerUserId: row.owner_user_id ?? undefined,
      connectedByName: row.connected_by_name ?? undefined,
      teamName: row.team_name,
      connected: true,
      connectedAt: row.connected_at.toISOString(),
    };
    return {
      id: row.id,
      type: row.type,
      workspaceId,
      connectionName: row.connection_name,
      connectionScope: row.connection_scope,
      ownerUserId: row.owner_user_id ?? undefined,
      connectedByName: row.connected_by_name ?? undefined,
      endpoint: row.owner,
      accountName: row.team_name ?? undefined,
      ...(row.type === "figma" && row.repo ? figmaTeamFromColumn(row.repo) : {}),
      connected: true,
      connectedAt: row.connected_at.toISOString(),
    };
  });
}

// A Figma connection stores its chosen team in the otherwise unused `repo`
// column as "<team id>" or "<team id>:<team name>".
function figmaTeamFromColumn(value: string): { teamId: string; teamName?: string } {
  const [teamId, ...name] = value.split(":");
  return { teamId, teamName: name.join(":") || undefined };
}

/** Saves the Figma team a member's own Figma connection may browse. */
export async function setFigmaTeam(input: { workspaceId: string; ownerUserId: string; teamId: string; teamName?: string }): Promise<boolean> {
  const value = input.teamName ? `${input.teamId}:${input.teamName}` : input.teamId;
  const result = await getPool().query(
    `UPDATE integrations SET repo = $3 WHERE workspace_id = $1 AND type = 'figma' AND account_key = $2`,
    [input.workspaceId, `personal:${input.ownerUserId}:figma`, value]
  );
  return (result.rowCount ?? 0) > 0;
}

// Server-side only (the agent's tool implementations) -- decrypts the real
// token. Never called from an HTTP route that returns straight to a client.
export async function getIntegrationCredential(
  workspaceId: string,
  type: "github" | "slack" | "linear" | "notion" | "figma",
  connectionId?: string
): Promise<{ token: string; owner?: string; repo?: string; teamName?: string } | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT owner, repo, team_name, encrypted_token
     FROM integrations WHERE workspace_id = $1 AND type = $2 AND ($3::uuid IS NULL OR id = $3) ORDER BY (connection_scope = 'shared') DESC, connected_at DESC LIMIT 1`,
    [workspaceId, type, connectionId ?? null]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    token: decryptToken(row.encrypted_token),
    owner: row.owner ?? undefined,
    repo: row.repo ?? undefined,
    teamName: row.team_name ?? undefined,
  };
}

export async function deleteIntegrationForOwner(
  workspaceId: string,
  type: "github" | "slack" | "linear" | "notion" | "figma",
  integrationId: string,
  ownerUserId: string
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM integrations WHERE workspace_id = $1 AND type = $2 AND id = $3 AND owner_user_id = $4`,
    [workspaceId, type, integrationId, ownerUserId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Retrieves a member's secret only for a server-side provider revocation. */
export async function getIntegrationCredentialForOwner(
  workspaceId: string,
  type: "github" | "slack" | "linear" | "notion" | "figma",
  integrationId: string,
  ownerUserId: string,
): Promise<{ token: string } | null> {
  const result = await getPool().query(
    "SELECT encrypted_token FROM integrations WHERE workspace_id=$1 AND type=$2 AND id=$3 AND owner_user_id=$4",
    [workspaceId, type, integrationId, ownerUserId],
  );
  return result.rows[0] ? { token: decryptToken(result.rows[0].encrypted_token) } : null;
}

export async function deletePersonalIntegrationsForUser(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM integrations WHERE owner_user_id = $1 AND connection_scope = 'personal'`, [userId]);
}

/** Re-encrypts every integration secret with the active key-ring key. Run
 * this only after deploying a key ring containing both the new and old keys. */
export async function reencryptIntegrationCredentials(): Promise<number> {
  const pool = getPool();
  const result = await pool.query("SELECT id, encrypted_token FROM integrations FOR UPDATE");
  let rotated = 0;
  for (const row of result.rows) {
    if (!needsTokenReencryption(row.encrypted_token)) continue;
    await pool.query("UPDATE integrations SET encrypted_token=$2 WHERE id=$1", [row.id, encryptToken(decryptToken(row.encrypted_token))]);
    rotated += 1;
  }
  return rotated;
}


// -- Pending GitHub write-action confirmation -------------------------
// See packages/shared-types PendingAction doc comment and
// services/chat-server/src/actions.ts for the full flow this backs.
