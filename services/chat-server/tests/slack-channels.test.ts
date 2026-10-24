import { describe, expect, it } from "vitest";
import { createSlackChannelLookup } from "../src/slack-channels.js";

describe("slack channel lookup", () => {
  it("returns the channel name for an ID and caches it", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      calls += 1;
      expect(String(url)).toBe("https://slack.com/api/conversations.info?channel=C024BE91L");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxp-token-1");
      return new Response(JSON.stringify({ ok: true, channel: { id: "C024BE91L", name: "announcements" } }));
    }) as typeof fetch;
    const lookup = createSlackChannelLookup(fetchImpl);
    expect(await lookup("xoxp-token-1", "C024BE91L")).toBe("announcements");
    expect(await lookup("xoxp-token-1", "C024BE91L")).toBe("announcements");
    expect(calls).toBe(1);
  });

  it("returns null when Slack refuses or can't be reached", async () => {
    const refused = createSlackChannelLookup((async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))) as typeof fetch);
    expect(await refused("xoxp-token-2", "C0000000X")).toBeNull();
    const offline = createSlackChannelLookup((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(await offline("xoxp-token-3", "C0000000Y")).toBeNull();
  });
});
