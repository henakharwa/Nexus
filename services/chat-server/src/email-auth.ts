import type { Express } from "express";
import * as db from "@mai-chat/db";
import { hashPassword, verifyPassword } from "./passwords.js";
import { issueSession, type UserAuthConfig } from "./auth.js";
import { sendVerificationEmail } from "./email-verification.js";
import { createMailer, defaultMailerConfig, type Mailer } from "./mailer.js";

export function registerEmailAuthRoutes(app: Express, config: UserAuthConfig, mailer: Mailer = createMailer(defaultMailerConfig())): void {
  app.post(["/auth/signup/email", "/auth/login/email"], async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // JSON and same-origin requests only, including login-CSRF protection.
    if (!req.is("application/json") || (req.headers.origin && req.headers.origin !== config.webAppUrl)) {
      return res.status(403).json({ error: "Invalid sign-in request." });
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const signup = req.path === "/auth/signup/email";
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
    // Bound expensive password work per IP and per account. Stored in the
    // database (like password-reset limits) so a restart or a second server
    // process does not reset the counters.
    const ipAllowed = await db.consumeRateLimit("email-auth-ip", req.ip ?? "unknown", 30, 900);
    const emailAllowed = !email || await db.consumeRateLimit("email-auth-email", email, 10, 900);
    if (!ipAllowed || !emailAllowed) {
      res.setHeader("Retry-After", "900");
      return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length > 128) {
      return res.status(400).json({ error: "Enter a valid email and a password of at most 128 characters." });
    }
    if (signup && (password.length < 12 || !displayName || displayName.length > 80)) {
      return res.status(400).json({ error: "Enter your name (up to 80 characters) and a password of at least 12 characters." });
    }
    try {
      let user;
      if (signup) {
        user = await db.createPasswordUser({
          email,
          displayName,
          passwordHash: await hashPassword(password),
          // Typing an address into a sign-up form never proves ownership of
          // it. Only the emailed verification link may mark it verified;
          // treating it as verified here would let someone pre-register a
          // victim's email and later receive the victim's Google/GitHub
          // sign-in, since verified emails are the account-linking key.
          emailVerified: false,
        });
      } else {
        const credential = await db.getPasswordCredential(email);
        const matches = await verifyPassword(password, credential?.passwordHash ?? null);
        // Keep the dummy password derivation above even when no account is
        // found. Both failures deliberately have the exact same response so
        // this endpoint cannot be used to enumerate registered addresses.
        if (!credential || !matches) return res.status(401).json({ error: "Invalid email or password." });
        user = await db.getUserById(credential.userId);
      }
      if (!user) return res.status(401).json({ error: "Incorrect email or password." });
      await issueSession(res, user.id, config);
      res.status(signup ? 201 : 200).json(user);
      // Only when verification is on: with it off, the emailed link would
      // just say verification is disabled.
      if (signup && config.emailVerificationEnabled) {
        // Fire-and-forget from the response's point of view -- signup
        // already succeeded and the session is already issued; a slow or
        // failing mail provider shouldn't turn a successful signup into
        // an error response. Failures are logged, not surfaced to the
        // client (they can always ask for a resend from the app once
        // signed in).
        void sendVerificationEmail(user, email, config, mailer).catch((error) => {
          console.error(`[email-auth] couldn't send the verification email to a new signup:`, error);
        });
      }
    } catch (error) {
      if (signup && (error as { code?: string }).code === "23505") {
        // Match other malformed sign-up responses. In particular, do not
        // disclose that this email is already registered or linked to OAuth.
        return res.status(400).json({ error: "Unable to create an account. Check your details and try again." });
      }
      res.status(503).json({ error: "Sign-in is temporarily unavailable. Please try again." });
    }
  });
}
