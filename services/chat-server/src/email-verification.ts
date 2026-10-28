// Email verification for password accounts. GitHub/Google logins never
// need this -- their email (when Google supplies one) is already
// provider-verified before this app ever sees it; only an email+password
// signup hands us an address nobody has confirmed control of yet.
import type { Express, Request, Response } from "express";
import * as db from "@mai-chat/db";
import type { User } from "@mai-chat/shared-types";
import { requireAuth, type UserAuthConfig } from "./auth.js";
import type { Mailer } from "./mailer.js";
import { NO_STORE } from "./http-utils.js";

export async function sendVerificationEmail(user: { id: string }, email: string, config: UserAuthConfig, mailer: Mailer): Promise<void> {
  const token = await db.createEmailVerificationToken(user.id, email);
  const link = new URL("/verify-email", config.webAppUrl);
  link.searchParams.set("token", token);
  await mailer.send({
    to: email,
    subject: "Verify your email for Nexus",
    text:
      `Welcome to Nexus! Confirm this is your email address:\n\n${link.toString()}\n\n` +
      `This link expires in 24 hours. If you didn't sign up, you can ignore this email.`,
  });
}

export function registerEmailVerificationRoutes(app: Express, config: UserAuthConfig, mailer: Mailer): void {
  app.use("/auth/verify-email", (_req, res, next) => { res.setHeader("Cache-Control", NO_STORE); next(); });
  app.use("/auth/resend-verification", (_req, res, next) => { res.setHeader("Cache-Control", NO_STORE); next(); });

  // Not requireAuth-gated on purpose: the person clicking a link from
  // their inbox may not have an active session in that browser (e.g. a
  // different browser/device than the one they signed up in) -- the
  // token itself, not a session, proves the click.
  app.post("/auth/verify-email", async (req: Request, res: Response) => {
    if (!config.emailVerificationEnabled) return res.status(404).json({ error: "Email verification is currently disabled." });
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token) return res.status(400).json({ error: "A verification token is required." });
    try {
      const user: User | null = await db.verifyEmailToken(token);
      if (!user) return res.status(400).json({ error: "That verification link is invalid or has expired. Request a new one from your account." });
      res.json({ verified: true, email: user.email ?? null });
    } catch {
      res.status(503).json({ error: "Couldn't verify your email right now. Please try again." });
    }
  });

  const resendAttempts = new Map<string, { count: number; expiresAt: number }>();
  app.post("/auth/resend-verification", requireAuth, async (req: Request, res: Response) => {
    if (!config.emailVerificationEnabled) return res.status(404).json({ error: "Email verification is currently disabled." });
    const now = Date.now();
    for (const [key, value] of resendAttempts) if (value.expiresAt <= now) resendAttempts.delete(key);
    const key = `user:${req.user!.id}`;
    const entry = resendAttempts.get(key) ?? { count: 0, expiresAt: now + 15 * 60 * 1000 };
    if (entry.count >= 3) {
      res.setHeader("Retry-After", "900");
      return res.status(429).json({ error: "Too many requests. Try again in 15 minutes." });
    }
    entry.count++; resendAttempts.set(key, entry);

    const credential = await db.getPasswordCredentialByUserId(req.user!.id);
    if (!credential) return res.status(400).json({ error: "This account signed in with GitHub or Google and has no email/password to verify." });
    if (credential.verified) return res.json({ alreadyVerified: true });
    await sendVerificationEmail(req.user!, credential.email, config, mailer);
    res.json({ sent: true });
  });
}
