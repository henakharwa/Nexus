// Adds a per-request Content-Security-Policy with a fresh nonce to every page
// (Security Validation scope 12). Next.js reads the nonce from the request's
// CSP header and stamps it on the scripts it renders, so only those run.
// Static headers (nosniff, framing, HSTS...) live in next.config.mjs.
import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy } from "./lib/security-headers";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const protocol = forwardedProto ? `${forwardedProto}:` : request.nextUrl.protocol;
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    selfOrigin: `${protocol}//${host}`,
    chatServerUrl: process.env.NEXT_PUBLIC_CHAT_SERVER_URL,
    chatServerWsUrl: process.env.NEXT_PUBLIC_CHAT_SERVER_WS_URL,
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Everything except built assets and media, which carry no script
      // context. Text routes such as robots.txt and every 404 keep the policy
      // (ZAP baseline rule 10038).
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|jpeg|svg|mp4|webm|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
