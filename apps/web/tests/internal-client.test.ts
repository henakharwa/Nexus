// Internal tests for the web client's error messages and API URL selection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, describeError, joinWorkspaceByCode } from "../lib/api";

describe("WEB-01 describeError", () => {
  it("basic: shows the server's own message when it is specific", () => {
    expect(describeError(new ApiError(409, "A workspace with this name already exists."), "fallback")).toBe("A workspace with this name already exists.");
  });
  it("edge: replaces generic server messages with a status-specific one", () => {
    expect(describeError(new ApiError(401, "request failed (401)"), "f")).toMatch(/session has expired/);
    expect(describeError(new ApiError(403, "request failed (403)"), "f")).toMatch(/permission/);
    expect(describeError(new ApiError(404, "request failed (404)"), "f")).toMatch(/no longer exists/);
    expect(describeError(new ApiError(429, "request failed (429)"), "f")).toMatch(/Too many requests/);
    expect(describeError(new ApiError(500, "request failed (500)"), "f")).toMatch(/server ran into a problem/);
    expect(describeError(new ApiError(503, ""), "f")).toMatch(/server ran into a problem/);
  });
  it("edge: an unrecognised 4xx with no message uses the caller's fallback", () => {
    expect(describeError(new ApiError(418, ""), "Could not save.")).toBe("Could not save.");
  });
  it("edge: network failures and unknown values", () => {
    expect(describeError(new TypeError("Failed to fetch"), "f")).toMatch(/Could not reach the chat server/);
    expect(describeError(new Error("Plain problem"), "f")).toBe("Plain problem");
    expect(describeError(new Error(""), "fallback")).toBe("fallback");
    expect(describeError("a string", "fallback")).toBe("fallback");
    expect(describeError(undefined, "fallback")).toBe("fallback");
    expect(describeError(null, "fallback")).toBe("fallback");
  });
});

describe("WEB-02 chat server URL", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it("basic: explicit environment URLs win", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_SERVER_URL", "https://api.example.test");
    vi.stubEnv("NEXT_PUBLIC_CHAT_SERVER_WS_URL", "wss://api.example.test");
    const config = await import("../lib/config");
    expect(config.CHAT_SERVER_URL).toBe("https://api.example.test");
    expect(config.CHAT_SERVER_WS_URL).toBe("wss://api.example.test");
  });
  it("edge: development without settings uses localhost:4000", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_SERVER_URL", "");
    vi.stubEnv("NEXT_PUBLIC_CHAT_SERVER_WS_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    const config = await import("../lib/config");
    expect(config.CHAT_SERVER_URL).toBe("http://localhost:4000");
  });
  it("edge: a production build in the browser uses the same origin under /api (never localhost)", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_SERVER_URL", "");
    vi.stubEnv("NEXT_PUBLIC_CHAT_SERVER_WS_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("window", { location: { protocol: "https:", host: "nexus.example.test", origin: "https://nexus.example.test" } });
    const config = await import("../lib/config");
    expect(config.CHAT_SERVER_URL).toBe("https://nexus.example.test/api");
    expect(config.CHAT_SERVER_WS_URL).toBe("wss://nexus.example.test/api");
  });
});

describe("WEB-03 join-code requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the pending result instead of pretending it is a workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ pending: true }), { status: 202 })));
    await expect(joinWorkspaceByCode("bright-otter-42")).resolves.toEqual({ pending: true });
  });
});
