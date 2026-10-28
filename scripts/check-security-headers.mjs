#!/usr/bin/env node
// Checks that a running Nexus deployment sends the browser security headers
// from Security Validation scope 12. Used by the ZAP workflow before the scan
// and handy after a deploy:
//
//   npm run security:headers -- https://staging.example.com
//   npm run security:headers -- http://localhost:3000 http://localhost:4000
//
// The first URL is the web app; the optional second URL is the API (defaults
// to <web>/api, the bundled Caddy layout). Exits 1 on any missing header.
const [webArg, apiArg] = process.argv.slice(2);
if (!webArg) {
  console.error("Usage: check-security-headers.mjs <web-url> [api-url]");
  process.exit(2);
}
const web = webArg.replace(/\/+$/, "");
const api = (apiArg ?? `${web}/api`).replace(/\/+$/, "");
const https = web.startsWith("https://");

const directive = (policy, name) =>
  (policy ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `) || part === name);

const checks = {
  page: (h) => {
    const csp = h.get("content-security-policy");
    const script = directive(csp, "script-src") ?? directive(csp, "default-src") ?? "";
    return [
      ["Content-Security-Policy present", Boolean(csp)],
      ["CSP script-src uses a nonce", /'nonce-[^']+'/.test(script)],
      ["CSP script-src has no 'unsafe-inline'", !/'unsafe-inline'/.test(script) || /'nonce-/.test(script)],
      ["CSP frame-ancestors 'none'", directive(csp, "frame-ancestors") === "frame-ancestors 'none'"],
      ["CSP object-src 'none'", directive(csp, "object-src") === "object-src 'none'"],
      ["X-Content-Type-Options nosniff", h.get("x-content-type-options") === "nosniff"],
      ["X-Frame-Options DENY", h.get("x-frame-options") === "DENY"],
      ["Referrer-Policy set", Boolean(h.get("referrer-policy"))],
      ["Permissions-Policy set", Boolean(h.get("permissions-policy"))],
      ["No X-Powered-By", !h.get("x-powered-by")],
      ...(https ? [["Strict-Transport-Security max-age >= 1 year", Number(/max-age=(\d+)/.exec(h.get("strict-transport-security") ?? "")?.[1] ?? 0) >= 31536000]] : []),
    ];
  },
  api: (h) => [
    ["CSP default-src 'none'", directive(h.get("content-security-policy"), "default-src") === "default-src 'none'"],
    ["CSP frame-ancestors 'none'", directive(h.get("content-security-policy"), "frame-ancestors") === "frame-ancestors 'none'"],
    ["X-Content-Type-Options nosniff", h.get("x-content-type-options") === "nosniff"],
    ["X-Frame-Options DENY", h.get("x-frame-options") === "DENY"],
    ["No X-Powered-By", !h.get("x-powered-by")],
    ...(https ? [["Strict-Transport-Security set", Boolean(h.get("strict-transport-security"))]] : []),
  ],
  publicShare: (h) => [
    ...checks.page(h),
    ["Cache-Control no-store", /no-store/.test(h.get("cache-control") ?? "")],
    ["X-Robots-Tag noindex", /noindex/.test(h.get("x-robots-tag") ?? "")],
  ],
};

const targets = [
  ["Landing page", `${web}/`, "page"],
  ["Password reset page (token in URL)", `${web}/reset-password?token=header-check`, "page"],
  // Caddy adds no-store / noindex to public share paths; `next start` alone does not.
  ["Public share page", `${web}/shared/00000000-0000-4000-8000-000000000000`, apiArg ? "page" : "publicShare"],
  ["API health check", `${api}/healthz`, "api"],
];

let failures = 0;
for (const [label, url, kind] of targets) {
  let response;
  try {
    response = await fetch(url, { redirect: "manual" });
  } catch (error) {
    console.log(`✗ ${label}: ${url} unreachable (${error.message})`);
    failures += 1;
    continue;
  }
  console.log(`\n${label} — ${url} (${response.status})`);
  for (const [name, ok] of checks[kind](response.headers)) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) failures += 1;
  }
}
console.log(failures ? `\n${failures} header check(s) failed.` : "\nAll security header checks passed.");
process.exit(failures ? 1 : 0);
