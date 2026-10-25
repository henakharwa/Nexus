import { describe, expect, it } from "vitest";
import { channelMentions, createSlackChannelFinder, createSlackChannelLookup } from "../src/slack-channels.js";
import { describeSlackChannelMentions } from "../src/server.js";

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

describe("finding channels by name", () => {
  it("reads every page of the member's channel list, including channels with no messages", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      const cursor = new URL(String(url)).searchParams.get("cursor");
      return new Response(
        JSON.stringify(
          cursor
            ? { ok: true, channels: [{ id: "C0BUGS1234", name: "bugs" }] }
            : { ok: true, channels: [{ id: "C0ENG12345", name: "engineering" }], response_metadata: { next_cursor: "page2" } }
        )
      );
    }) as typeof fetch;
    const find = createSlackChannelFinder(fetchImpl);
    expect(await find("xoxp-finder-1", ["#Bugs", "engineering", "nope"])).toEqual({ bugs: "C0BUGS1234", engineering: "C0ENG12345", nope: null });
    expect(urls[0]).toContain("types=public_channel%2Cprivate_channel");
    expect(urls[0]).toContain("exclude_archived=true");
    // Cached: a second request doesn't list the channels again.
    await find("xoxp-finder-1", ["bugs"]);
    expect(urls).toHaveLength(2);
  });

  it("says nothing (rather than 'not found') when Slack can't be asked", async () => {
    const find = createSlackChannelFinder((async () => new Response(JSON.stringify({ ok: false, error: "missing_scope" }))) as typeof fetch);
    expect(await find("xoxp-finder-2", ["bugs"])).toEqual({});
  });

  it("picks #channel mentions out of a message, but not issue numbers", () => {
    expect(channelMentions('Post "hi" in #bugs and (#eng-alerts). See PR #17 and #42.')).toEqual(["bugs", "eng-alerts"]);
    expect(channelMentions("no channels here")).toEqual([]);
  });

  it("describes found and missing channels for the agent, from the newest message only", async () => {
    const messages = [
      { role: "user", content: "earlier: post in #old" },
      { role: "agent", content: "Done" },
      { role: "user", content: "Post hello in #bugs and #nope" },
    ];
    const text = await describeSlackChannelMentions(messages, async (names) => {
      expect(names).toEqual(["bugs", "nope"]);
      return { bugs: "C0BUGS1234", nope: null };
    });
    expect(text).toBe("- #bugs = channel ID C0BUGS1234\n- #nope: not found among the channels this member can see");
    expect(await describeSlackChannelMentions([{ role: "user", content: "no channel" }], async () => ({}))).toBeNull();
    expect(await describeSlackChannelMentions(messages, undefined)).toBeNull();
  });
});
