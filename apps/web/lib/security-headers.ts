// Browser security headers for the web app (Security Validation scope 12).
//
// The Content-Security-Policy is built per request by proxy.ts with a fresh
// nonce, so only scripts Next.js itself renders can run: an injected
// <script> or inline event handler is blocked even if markup ever slips
// through the markdown renderer. The other headers are static and are set in
// next.config.mjs (and again at the edge by Caddy).

export interface CspOptions {
  /** Base64 nonce for this response; Next.js adds it to its own scripts. */
  nonce: string;
  /** `next dev` needs eval for React's debugging helpers. */
  isDev: boolean;
  /** The page's own origin, e.g. https://nexus.example.com. */
  selfOrigin?: string;
  /** NEXT_PUBLIC_CHAT_SERVER_URL / NEXT_PUBLIC_CHAT_SERVER_WS_URL, when set. */
  chatServerUrl?: string;
  chatServerWsUrl?: string;
  /** NEXT_PUBLIC_SENTRY_DSN, when browser error tracking is on. */
  sentryDsn?: string;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return null;
  }
}

/** The WebSocket origin that matches an http(s) origin (same host and port). */
function socketOriginFor(origin: string | null): string | null {
  if (!origin) return null;
  if (origin.startsWith("https://")) return `wss://${origin.slice("https://".length)}`;
  if (origin.startsWith("http://")) return `ws://${origin.slice("http://".length)}`;
  return null;
}

/** Where the browser may send fetch/XHR/WebSocket traffic. */
export function connectSources(options: Omit<CspOptions, "nonce">): string[] {
  const sources = new Set<string>(["'self'"]);
  // The production build talks to its own origin under /api (Caddy routes
  // it). Older browsers do not treat wss: as covered by 'self', so name it.
  const self = originOf(options.selfOrigin);
  const selfSocket = socketOriginFor(self);
  if (selfSocket) sources.add(selfSocket);
  const api = originOf(options.chatServerUrl) ?? (options.isDev ? "http://localhost:4000" : null);
  const ws = originOf(options.chatServerWsUrl) ?? (options.isDev ? "ws://localhost:4000" : null);
  for (const origin of [api, ws, socketOriginFor(api)]) if (origin && origin !== self) sources.add(origin);
  // Sentry's browser SDK posts to the DSN's host.
  if (options.sentryDsn) {
    try {
      sources.add(new URL(options.sentryDsn).origin);
    } catch {
      // A malformed DSN disables reporting anyway; never fail the page.
    }
  }
  return [...sources];
}

export function buildContentSecurityPolicy(options: CspOptions): string {
  const api = originOf(options.chatServerUrl) ?? (options.isDev ? "http://localhost:4000" : null);
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    // 'strict-dynamic' lets the nonce'd Next.js runtime load its own chunks;
    // nothing else (inline or from another host) can execute.
    [
      "script-src",
      ["'self'", `'nonce-${options.nonce}'`, "'strict-dynamic'", ...(options.isDev ? ["'unsafe-eval'"] : [])],
    ],
    // React `style={...}` props are inline style attributes; they cannot run
    // code, so allowing them is the accepted trade-off.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'"]],
    ["connect-src", connectSources(options)],
    ["frame-src", ["'none'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    // Sign-in buttons navigate (not POST) to the chat server; keep forms local
    // apart from the API origin used in development.
    ["form-action", ["'self'", ...(api && api !== originOf(options.selfOrigin) ? [api] : [])]],
    ["frame-ancestors", ["'none'"]],
  ];
  const policy = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  // Only on an HTTPS site: on a plain-http staging host it would rewrite the
  // app's own API calls to https and break them.
  if (!options.isDev && options.selfOrigin?.startsWith("https://")) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

export interface StaticHeader {
  key: string;
  value: string;
}

/** Headers that are the same on every response (pages and static assets). */
export function staticSecurityHeaders(options: { isProduction: boolean }): StaticHeader[] {
  const headers: StaticHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Token-bearing pages (invite, reset, verify) keep the path and query on
    // same-origin requests only; other sites see just the origin.
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Legacy anti-framing for browsers without CSP frame-ancestors.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()",
    },
  ];
  // Only meaningful over HTTPS; browsers ignore it on plain http, but keep it
  // out of local development so localhost is never pinned.
  if (options.isProduction)
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  return headers;
}
