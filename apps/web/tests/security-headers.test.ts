import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, connectSources, staticSecurityHeaders } from "../lib/security-headers";

const directive = (policy: string, name: string) =>
  policy
    .split("; ")
    .find((part) => part.startsWith(`${name} `))
    ?.slice(name.length + 1)
    .split(" ") ?? [];

describe("Content-Security-Policy (scope 12)", () => {
  const production = buildContentSecurityPolicy({ nonce: "abc123==", isDev: false, selfOrigin: "https://nexus.example.com" });

  it("only runs scripts carrying this response's nonce; no inline or eval in production", () => {
    const scripts = directive(production, "script-src");
    expect(scripts).toContain("'nonce-abc123=='");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });
  it("blocks framing, plugins, base-tag hijacking and foreign frames", () => {
    expect(directive(production, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(production, "object-src")).toEqual(["'none'"]);
    expect(directive(production, "base-uri")).toEqual(["'self'"]);
    expect(directive(production, "frame-src")).toEqual(["'none'"]);
    expect(production).toContain("upgrade-insecure-requests");
  });
  it("allows the same-origin API and its WebSocket in production", () => {
    expect(directive(production, "connect-src")).toEqual(["'self'", "wss://nexus.example.com"]);
    expect(directive(production, "form-action")).toEqual(["'self'"]);
  });
  it("allows a separately hosted chat server and Sentry when configured", () => {
    const sources = connectSources({
      isDev: false,
      selfOrigin: "https://app.example.com",
      chatServerUrl: "https://api.example.com/v1",
      chatServerWsUrl: "wss://api.example.com/v1",
      sentryDsn: "https://key@o1.ingest.sentry.io/42",
    });
    expect(sources).toEqual(["'self'", "wss://app.example.com", "https://api.example.com", "wss://api.example.com", "https://o1.ingest.sentry.io"]);
  });
  it("development adds eval and the local chat server, and never upgrades to https", () => {
    const dev = buildContentSecurityPolicy({ nonce: "n", isDev: true, selfOrigin: "http://localhost:3000" });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toEqual(expect.arrayContaining(["http://localhost:4000", "ws://localhost:4000"]));
    expect(dev).not.toContain("upgrade-insecure-requests");
  });
  it("only upgrades insecure requests when the site itself is served over https", () => {
    const plain = buildContentSecurityPolicy({ nonce: "n", isDev: false, selfOrigin: "http://10.0.0.5:3000" });
    expect(plain).not.toContain("upgrade-insecure-requests");
    expect(directive(plain, "connect-src")).toContain("ws://10.0.0.5:3000");
  });
  it("ignores malformed or non-web URLs instead of widening the policy", () => {
    const sources = connectSources({ isDev: false, chatServerUrl: "javascript:alert(1)", chatServerWsUrl: "not a url", sentryDsn: "::" });
    expect(sources).toEqual(["'self'"]);
  });
});

describe("static security headers", () => {
  it("sets nosniff, referrer policy, anti-framing and permissions policy; HSTS only in production", () => {
    const keys = staticSecurityHeaders({ isProduction: false }).map((h) => h.key);
    expect(keys).toEqual(expect.arrayContaining(["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy"]));
    expect(keys).not.toContain("Strict-Transport-Security");
    expect(staticSecurityHeaders({ isProduction: true }).find((h) => h.key === "Strict-Transport-Security")?.value).toMatch(/max-age=31536000/);
  });
  it("next.config.mjs serves the same headers on every path", async () => {
    // @ts-expect-error -- plain JS config file without type declarations
    const nextConfig: unknown = (await import("../next.config.mjs")).default;
    const routes = await (nextConfig as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> }).headers();
    expect(routes[0].source).toBe("/:path*");
    const expected = staticSecurityHeaders({ isProduction: process.env.NODE_ENV === "production" });
    expect(routes[0].headers).toEqual(expected);
    expect((nextConfig as { poweredByHeader?: boolean }).poweredByHeader).toBe(false);
  });
});
