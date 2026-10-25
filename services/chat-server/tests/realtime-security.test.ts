import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { RoomRegistry } from "../src/rooms.js";
import { CHAT_MESSAGES_PER_CONNECTION_PER_MINUTE, createConnectionMessageRateLimiter } from "../src/server.js";

function socket(): WebSocket & { close: ReturnType<typeof vi.fn> } {
  return {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    close: vi.fn(),
    send: vi.fn(),
  } as unknown as WebSocket & { close: ReturnType<typeof vi.fn> };
}

describe("realtime security", () => {
  it("disconnects every live socket for a removed or changed member", () => {
    const rooms = new RoomRegistry();
    const target = socket();
    const teammate = socket();
    rooms.join("workspace", target, {
      clientId: "target-client",
      userId: "target-user",
      displayName: "Target",
      connectedAt: new Date().toISOString(),
      activeConversationId: "conversation",
    });
    rooms.join("workspace", teammate, {
      clientId: "teammate-client",
      userId: "teammate-user",
      displayName: "Teammate",
      connectedAt: new Date().toISOString(),
      activeConversationId: "conversation",
    });

    rooms.disconnectMember("workspace", "target-user", "access changed");

    expect(target.close).toHaveBeenCalledWith(4009, "access changed");
    expect(teammate.close).not.toHaveBeenCalled();
    expect(rooms.participants("workspace").map((member) => member.userId)).toEqual(["teammate-user"]);
  });

  it("limits chat volume independently for each socket", () => {
    const first = createConnectionMessageRateLimiter();
    const second = createConnectionMessageRateLimiter();
    for (let index = 0; index < CHAT_MESSAGES_PER_CONNECTION_PER_MINUTE; index++) expect(first.allow(1_000)).toBe(true);
    expect(first.allow(1_000)).toBe(false);
    expect(second.allow(1_000)).toBe(true);
    expect(first.allow(61_001)).toBe(true);
  });
});
