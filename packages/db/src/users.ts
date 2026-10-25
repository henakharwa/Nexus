// Users, sessions, email verification and password reset.
import { randomBytes } from "node:crypto";
import type {
  User } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";
import { hashSessionToken } from "./crypto.js";


export function toUser(row: {
  id: string;
  github_id: string | null;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: Date;
  // Only present on queries that LEFT JOIN password_credentials -- undefined
  // (not null) means "this query didn't ask", null means "asked, no
  // password_credentials row" (a GitHub/Google account).
  email?: string | null;
  email_verified_at?: Date | null;
}): User {
  return {
    id: row.id,
    githubId: row.github_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at.toISOString(),
    ...(row.email != null ? { email: row.email, emailVerified: row.email_verified_at != null } : {}),
  };
}

// A verified provider email is the shared account key. The provider's stable
// subject remains the credential key; this mapping only tells us which user
// should receive a newly-seen provider credential.
export function normalizedEmail(email: string): string { return email.trim().toLowerCase(); }

async function findOrCreateUserForVerifiedEmail(input: {
  providerColumn: "github_id" | "google_id";
  providerId: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}): Promise<User> {
  const client = await getPool().connect();
  const email = normalizedEmail(input.email);
  try {
    await client.query("BEGIN");
    // Serialize first-time linking for one email so two OAuth callbacks
    // cannot create separate accounts before either records its identity.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    const existingProvider = await client.query(
      `SELECT id FROM users WHERE ${input.providerColumn} = $1`, [input.providerId]
    );
    const existingEmail = existingProvider.rows[0]
      ? null
      : await client.query(`SELECT user_id FROM user_email_identities WHERE email = $1`, [email]);
    const userId = existingProvider.rows[0]?.id ?? existingEmail?.rows[0]?.user_id;
    let result;
    if (userId) {
      result = await client.query(
        `UPDATE users SET ${input.providerColumn} = $2, username = $3, display_name = $4, avatar_url = $5
         WHERE id = $1 RETURNING id, github_id, username, display_name, avatar_url, created_at`,
        [userId, input.providerId, input.username, input.displayName, input.avatarUrl ?? null]
      );
    } else {
      result = await client.query(
        `INSERT INTO users (${input.providerColumn}, username, display_name, avatar_url) VALUES ($1, $2, $3, $4)
         RETURNING id, github_id, username, display_name, avatar_url, created_at`,
        [input.providerId, input.username, input.displayName, input.avatarUrl ?? null]
      );
    }
    await client.query(
      `INSERT INTO user_email_identities (email, user_id) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [email, result.rows[0].id]
    );
    await client.query("COMMIT");
    return { ...toUser(result.rows[0]), email, emailVerified: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function upsertUserFromGithub(input: {
  githubId: string;
  email?: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}): Promise<User> {
  // Compatibility for existing test fixtures and legacy callers. Production
  // OAuth always supplies a GitHub-verified email and takes the linking path.
  if (!input.email) {
    const result = await getPool().query(
      `INSERT INTO users (github_id, username, display_name, avatar_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_id) DO UPDATE SET username = $2, display_name = $3, avatar_url = $4
       RETURNING id, github_id, username, display_name, avatar_url, created_at`,
      [input.githubId, input.username, input.displayName, input.avatarUrl ?? null]
    );
    return toUser(result.rows[0]);
  }
  return findOrCreateUserForVerifiedEmail({ providerColumn: "github_id", providerId: input.githubId, email: input.email, username: input.username, displayName: input.displayName, avatarUrl: input.avatarUrl });
}

export async function getUserById(id: string): Promise<User | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT u.id, u.github_id, u.username, u.display_name, u.avatar_url, u.created_at,
            pc.email, pc.email_verified_at
     FROM users u LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE u.id = $1`,
    [id]
  );
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export async function createPasswordUser(input: { email: string; displayName: string; passwordHash: string; emailVerified?: boolean }): Promise<User> {
  const client = await getPool().connect();
  const email = normalizedEmail(input.email);
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    // A password sign-up proves nothing about who owns the email, so it must
    // never attach to an account that already owns that email through Google
    // or GitHub -- doing so would let anyone who knows the address set a
    // password on someone else's account and sign straight in. Refuse with the
    // same unique-violation code a duplicate password account produces, so
    // the route answers with its usual 409.
    const existing = await client.query(`SELECT user_id FROM user_email_identities WHERE email = $1`, [email]);
    if (existing.rows[0]) {
      throw Object.assign(new Error("An account already uses this email."), { code: "23505" });
    }
    const result = await client.query(
      `INSERT INTO users (username, display_name) VALUES ($1, $2)
       RETURNING id, github_id, username, display_name, avatar_url, created_at`,
      [email, input.displayName]
    );
    await client.query(
      `INSERT INTO password_credentials (user_id, email, password_hash, email_verified_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)`,
      [result.rows[0].id, email, input.passwordHash, input.emailVerified ?? false]
    );
    if (input.emailVerified) await client.query(
      `INSERT INTO user_email_identities (email, user_id) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [email, result.rows[0].id]
    );
    await client.query("COMMIT");
    return { ...toUser(result.rows[0]), email, emailVerified: input.emailVerified ?? false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function getPasswordCredential(email: string): Promise<{ userId: string; passwordHash: string } | null> {
  const result = await getPool().query(`SELECT user_id, password_hash FROM password_credentials WHERE email = $1`, [normalizedEmail(email)]);
  const row = result.rows[0];
  return row ? { userId: row.user_id, passwordHash: row.password_hash } : null;
}

export async function upsertUserFromGoogle(input: { googleId: string; email: string; displayName: string; avatarUrl?: string }): Promise<User> {
  return findOrCreateUserForVerifiedEmail({ providerColumn: "google_id", providerId: input.googleId, email: input.email, username: input.email, displayName: input.displayName, avatarUrl: input.avatarUrl });
}

// Mints a new session for a just-authenticated user and returns the RAW
// token -- this is the only place the raw value ever exists outside the
// browser's own cookie; only its hash (hashSessionToken, src/crypto.ts)
// is written to the sessions table.
export async function createSession(userId: string, ttlMs: number): Promise<{ token: string; expiresAt: string }> {
  const pool = getPool();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashSessionToken(token), userId, expiresAt]
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

// Looks up who a raw session-cookie token belongs to, or null if it
// doesn't match a live (unexpired) session -- an expired row is treated
// as absent rather than actively deleted here, since a request handler
// has no business doing cleanup writes on the hot path; nothing currently
// prunes expired rows, which is fine at this project's scale (see the
// same "deliberately simple for Phase 1/2" reasoning used elsewhere in
// this package) but would be worth a periodic sweep at real scale.
export async function getUserBySessionToken(token: string): Promise<User | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT u.id, u.github_id, u.username, u.display_name, u.avatar_url, u.created_at,
            pc.email, pc.email_verified_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashSessionToken(token)]
  );
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

// Sign-out -- deletes the one session this token names, not every session
// for the user (a sign-out on one device/browser shouldn't kill sessions
// elsewhere).
export async function deleteSession(token: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashSessionToken(token)]);
}

/** Number of the user's sessions that are still live (signed in somewhere). */
export async function countActiveSessionsForUser(userId: string): Promise<number> {
  const result = await getPool().query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > now()`, [userId]);
  return Number(result.rows[0]?.n ?? 0);
}

export interface SessionSummary {
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

/** Lists live sessions without ever returning a session token or token hash. */
export async function listSessionsForUser(userId: string, currentToken: string | null): Promise<SessionSummary[]> {
  const currentHash = currentToken ? hashSessionToken(currentToken) : null;
  const result = await getPool().query(
    `SELECT token_hash, created_at, expires_at FROM sessions
     WHERE user_id = $1 AND expires_at > now()
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map((row: { token_hash: string; created_at: Date; expires_at: Date }) => ({
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    current: currentHash === row.token_hash,
  }));
}

/** Revokes every live session except the browser making this request. */
export async function revokeOtherSessionsForUser(userId: string, currentToken: string): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING token_hash`,
    [userId, hashSessionToken(currentToken)]
  );
  return result.rowCount ?? 0;
}

/** Removes expired sessions outside the request path. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await getPool().query(`DELETE FROM sessions WHERE expires_at <= now() RETURNING token_hash`);
  return result.rowCount ?? 0;
}

// -- Email verification -------------------------------------------------
// Only meaningful for an email+password account -- see the baseline migration's
// comment on password_credentials.email_verified_at.

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h -- just an email click, generous is fine.

export async function createEmailVerificationToken(userId: string, email: string): Promise<string> {
  const pool = getPool();
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO email_verification_tokens (token_hash, user_id, email, expires_at) VALUES ($1, $2, $3, $4)`,
    [hashSessionToken(token), userId, email.toLowerCase().trim(), new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS)]
  );
  return token;
}

// Single-use: the token row is deleted whether or not it turns out to be
// valid. Returns the now-verified user, or null if the token is
// unknown/expired.
export async function verifyEmailToken(rawToken: string): Promise<User | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `DELETE FROM email_verification_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id, email`,
      [hashSessionToken(rawToken)]
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const { user_id: userId, email } = found.rows[0] as { user_id: string; email: string };
    // Only marks it verified if the account's current email still
    // matches what this token was issued for -- there's no "change
    // email" feature yet so this can't currently diverge, but keeps the
    // invariant honest if that ever changes.
    await client.query(
      `UPDATE password_credentials SET email_verified_at = now() WHERE user_id = $1 AND email = $2`,
      [userId, email]
    );
    await client.query("COMMIT");
    return getUserById(userId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPasswordCredentialByUserId(userId: string): Promise<{ email: string; verified: boolean } | null> {
  const result = await getPool().query(
    `SELECT email, email_verified_at FROM password_credentials WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? { email: row.email, verified: row.email_verified_at !== null } : null;
}

// -- Password reset -------------------------------------------------------

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h -- tighter than email verification, since this changes a credential.

// Always safe to call for an unknown email -- returns null rather than
// throwing, so the route layer can give the same generic response either
// way (see password-reset.ts's account-enumeration-safety comment).
export async function createPasswordResetToken(email: string): Promise<{ token: string; userId: string } | null> {
  const credential = await getPasswordCredential(email);
  if (!credential) return null;
  const token = randomBytes(32).toString("base64url");
  await getPool().query(
    `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashSessionToken(token), credential.userId, new Date(Date.now() + PASSWORD_RESET_TTL_MS)]
  );
  return { token, userId: credential.userId };
}

// Single-use: a valid, unexpired, not-yet-used token is marked used (not
// deleted -- used_at is what makes a replay of the same link fail
// closed) and its user id returned; anything else returns null.
export async function consumePasswordResetToken(rawToken: string): Promise<string | null> {
  const result = await getPool().query(
    `UPDATE password_reset_tokens SET used_at = now()
     WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL
     RETURNING user_id`,
    [hashSessionToken(rawToken)]
  );
  return result.rows[0]?.user_id ?? null;
}

export async function updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await getPool().query(`UPDATE password_credentials SET password_hash = $1 WHERE user_id = $2`, [passwordHash, userId]);
}

// Signs the account out everywhere -- called right after a successful
// password reset so a session an attacker already had open (e.g. from
// the leaked old password) doesn't ride out its remaining 30-day expiry.
export async function deleteSessionsForUser(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}
