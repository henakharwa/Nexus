// Database utilities: advisory locks, OAuth state, rate limits and health checks.
import { getPool } from "./pool.js";


/**
 * Runs a maintenance task only when this server instance owns its database
 * advisory lock. It keeps in-process timers safe when the service scales to
 * more than one instance without adding a separate queue dependency.
 */
export async function runWithAdvisoryLock<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
  const outcome = await tryWithAdvisoryLock(key, task);
  return outcome.acquired ? outcome.value : undefined;
}

/**
 * Runs `task` only if no other process or request holds the lock for `key`.
 * Postgres advisory locks belong to one connection, so the lock is taken and
 * released on a single dedicated connection -- taking it through the shared
 * pool could release it on a different connection and leave it held.
 */
export async function tryWithAdvisoryLock<T>(key: string, task: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const client = await getPool().connect();
  let locked = false;
  try {
    const acquired = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key]);
    locked = Boolean(acquired.rows[0]?.locked);
    if (!locked) return { acquired: false };
    return { acquired: true, value: await task() };
  } finally {
    let releaseError: unknown;
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch((error) => { releaseError = error; });
    // A connection whose unlock failed may still hold the lock; destroy it
    // instead of returning it to the pool.
    client.release(releaseError instanceof Error ? releaseError : undefined);
  }
}

export async function saveOAuthPendingState(state: string, flow: string, payload: Record<string, unknown>, expiresAt: Date): Promise<void> {
  await getPool().query("DELETE FROM oauth_pending_states WHERE expires_at <= now()");
  await getPool().query("INSERT INTO oauth_pending_states (state,flow,payload,expires_at) VALUES ($1,$2,$3,$4)", [state, flow, JSON.stringify(payload), expiresAt]);
}
export async function consumeOAuthPendingState<T extends Record<string, unknown>>(state: string, flow: string): Promise<T | null> {
  await getPool().query("DELETE FROM oauth_pending_states WHERE state=$1 AND expires_at <= now()", [state]);
  const result = await getPool().query("DELETE FROM oauth_pending_states WHERE state=$1 AND flow=$2 AND expires_at > now() RETURNING payload", [state, flow]);
  return result.rows[0]?.payload as T | undefined ?? null;
}
export async function consumeRateLimit(scope: string, subject: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
  return (await takeRateLimit(scope, subject, maxAttempts, windowSeconds)).allowed;
}

/**
 * Counts one attempt against a fixed window and reports whether it is
 * allowed, plus how many seconds remain until the window resets (for a
 * Retry-After header and a readable message).
 */
export async function takeRateLimit(scope: string, subject: string, maxAttempts: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  await getPool().query("DELETE FROM auth_rate_limits WHERE window_ends_at <= now()");
  const result = await getPool().query(`INSERT INTO auth_rate_limits (scope,subject,attempts,window_ends_at) VALUES ($1,$2,1,now()+($3 * interval '1 second')) ON CONFLICT (scope,subject) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.window_ends_at <= now() THEN 1 ELSE auth_rate_limits.attempts+1 END, window_ends_at=CASE WHEN auth_rate_limits.window_ends_at <= now() THEN now()+($3 * interval '1 second') ELSE auth_rate_limits.window_ends_at END RETURNING attempts, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_ends_at - now()))))::int AS retry_after`, [scope, subject, windowSeconds]);
  return { allowed: Number(result.rows[0].attempts) <= maxAttempts, retryAfterSeconds: Number(result.rows[0].retry_after) };
}

/** Reports whether a subject has already used up its attempts in the current window, without consuming one. */
export async function isRateLimited(scope: string, subject: string, maxAttempts: number): Promise<boolean> {
  const result = await getPool().query("SELECT attempts FROM auth_rate_limits WHERE scope=$1 AND subject=$2 AND window_ends_at > now()", [scope, subject]);
  return result.rows.length > 0 && Number(result.rows[0].attempts) >= maxAttempts;
}

/** A deliberately small database readiness probe for the deployment health endpoint. */
export async function checkDatabaseHealth(): Promise<void> {
  await getPool().query("SELECT 1");
}
