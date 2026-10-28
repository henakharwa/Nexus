/** @type {import('next').NextConfig} */

// Static browser security headers (Security Validation scope 12). Keep in
// step with staticSecurityHeaders() in lib/security-headers.ts, which the
// tests check. The per-request Content-Security-Policy is added by proxy.ts.
const isProduction = process.env.NODE_ENV === "production";
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()",
  },
  ...(isProduction ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // The browser tests (scripts/e2e.mjs) build into their own folder, pointed
  // at a local test server, so they never overwrite the regular build.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
