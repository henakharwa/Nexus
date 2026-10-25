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

/**
 * Finds channels by name for "#name" mentions in a chat message, so the
 * agent gets the exact channel instead of guessing. Uses Slack's channel
 * list (conversations.list), which includes channels with no messages yet --
 * unlike message search, which the agent would otherwise fall back to.
 * Returns each requested name mapped to its ID, or null when no channel
 * the member can see has that name.
 */
export type SlackChannelFinder = (token: string, names: string[]) => Promise<Record<string, string | null>>;

const directoryCache = new Map<string, { channels: Map<string, string>; expiresAt: number }>();

export function createSlackChannelFinder(fetchImpl: typeof fetch = fetch): SlackChannelFinder {
  async function directory(token: string): Promise<Map<string, string> | null> {
    const key = token.slice(-12);
    const cached = directoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.channels;
    const channels = new Map<string, string>();
    let cursor = "";
    // Up to 5 pages of 1,000 channels; plenty for one workspace.
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ types: "public_channel,private_channel", exclude_archived: "true", limit: "1000" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetchImpl(`https://slack.com/api/conversations.list?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; channels?: Array<{ id?: string; name?: string }>; response_metadata?: { next_cursor?: string } };
      if (!body.ok) return page === 0 ? null : channels;
      for (const channel of body.channels ?? []) if (channel.id && channel.name) channels.set(channel.name.toLowerCase(), channel.id);
      cursor = body.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    directoryCache.set(key, { channels, expiresAt: Date.now() + 5 * 60_000 });
    return channels;
  }
  return async (token, names) => {
    const wanted = [...new Set(names.map((name) => name.replace(/^#/, "").toLowerCase()))];
    if (wanted.length === 0) return {};
    let channels: Map<string, string> | null = null;
    try {
      channels = await directory(token);
    } catch {
      channels = null;
    }
    // If Slack couldn't be asked, say nothing rather than "not found".
    if (!channels) return {};
    return Object.fromEntries(wanted.map((name) => [name, channels!.get(name) ?? null]));
  };
}

/** "#bugs" and "#eng-alerts" mentioned in a message, without the "#". Ignores "#12" (issue numbers). */
export function channelMentions(text: string): string[] {
  const names = [...text.matchAll(/(?:^|[\s(])#([a-z0-9][a-z0-9._-]{0,79})/gi)].map((match) => match[1].replace(/[.]+$/, ""));
  return [...new Set(names.filter((name) => !/^\d+$/.test(name)).map((name) => name.toLowerCase()))];
}
