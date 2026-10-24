// Looks up a Slack channel's name from its ID, so approval rules written
// with a channel name ("announcements") also match actions that name the
// channel by ID ("C024BE91L"), which is what Slack's MCP tools usually pass.
// Uses the member's own Slack user token (channels:read and groups:read are
// among the scopes slack-oauth.ts asks for).

export type SlackChannelLookup = (token: string, channelId: string) => Promise<string | null>;

const cache = new Map<string, { name: string | null; expiresAt: number }>();

export function createSlackChannelLookup(fetchImpl: typeof fetch = fetch): SlackChannelLookup {
  return async (token, channelId) => {
    const key = `${token.slice(-12)}:${channelId}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    let name: string | null = null;
    try {
      const response = await fetchImpl(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; channel?: { name?: string } };
      name = body.ok && body.channel?.name ? body.channel.name : null;
    } catch {
      name = null;
    }
    // Remember names for an hour, failures only briefly.
    cache.set(key, { name, expiresAt: Date.now() + (name ? 60 * 60_000 : 30_000) });
    return name;
  };
}
