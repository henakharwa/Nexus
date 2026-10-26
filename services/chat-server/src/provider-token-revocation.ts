// Best-effort OAuth token revocation. Local deletion always proceeds even if
// a provider is temporarily unavailable, so an unusable local credential is
// never retained. OAuth providers treat revocation as idempotent.
export async function revokeProviderToken(
  provider: "github" | "slack" | "linear" | "notion" | "figma",
  token: string,
  github?: { clientId: string; clientSecret: string },
): Promise<void> {
  try {
    if (provider === "github" && github?.clientId && github.clientSecret) {
      const basic = Buffer.from(`${github.clientId}:${github.clientSecret}`).toString("base64");
      await fetch(`https://api.github.com/applications/${encodeURIComponent(github.clientId)}/token`, {
        method: "DELETE",
        headers: { authorization: `Basic ${basic}`, accept: "application/vnd.github+json", "content-type": "application/json" },
        body: JSON.stringify({ access_token: token }), signal: AbortSignal.timeout(5_000),
      });
    } else if (provider === "slack") {
      await fetch("https://slack.com/api/auth.revoke", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: "test=false", signal: AbortSignal.timeout(5_000),
      });
    }
    // Linear, Notion, and Figma do not offer a universal token-revocation
    // endpoint for every OAuth configuration. Removing the encrypted local
    // copy remains immediate; their provider-console revocation is separate.
  } catch (error) {
    console.warn(`[integrations] ${provider} token revocation failed; local credential will still be removed`, error instanceof Error ? error.message : String(error));
  }
}
