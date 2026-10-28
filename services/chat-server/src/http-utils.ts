// Small helpers shared by server.ts and actions.ts -- pulled out once two
// files needed the same UUID-param validation and error-formatting logic.

// Express 5 widened route-param typing to `string | string[]` even for a
// plain named param like `:id` (to cover repeated/wildcard segments).
export function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Cache-Control for per-user and sign-in responses: never stored by the
 * browser or a shared proxy (the full set OWASP ZAP rule 10015 expects).
 */
export const NO_STORE = "no-store, no-cache, must-revalidate";
