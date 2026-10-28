// Forgot/reset password for email+password accounts. Deliberately
// account-enumeration-safe: /auth/forgot-password always returns the
// same response whether or not the email belongs to a real account, so
// it can't be used to check who has signed up here.
import type { Express, Request, Response } from "express";
import * as db from "@mai-chat/db";
import { hashPassword } from "./passwords.js";
import { issueSession, type UserAuthConfig } from "./auth.js";
import type { Mailer } from "./mailer.js";
import { NO_STORE } from "./http-utils.js";

export function registerPasswordResetRoutes(app: Express, config: UserAuthConfig, mailer: Mailer): void {
  app.use("/auth/forgot-password", (_req, res, next) => { res.setHeader("Cache-Control", NO_STORE); next(); });
  app.use("/auth/reset-password", (_req, res, next) => { res.setHeader("Cache-Control", NO_STORE); next(); });

  app.post("/auth/forgot-password", async (req: Request, res: Response) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    // Same generic response every time this handler returns -- an
    // attacker probing emails should learn nothing from the reply.
    const generic = { message: "If an account exists for that email, we've sent a password reset link." };
    const ipAllowed = await db.consumeRateLimit("password-reset-ip", req.ip ?? "unknown", 10, 900);
    const emailAllowed = !email || await db.consumeRateLimit("password-reset-email", email, 5, 900);
    if (!ipAllowed || !emailAllowed) {
      res.setHeader("Retry-After", "900");
      return res.status(429).json(generic);
    }
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json(generic);
    try {
      const created = await db.createPasswordResetToken(email);
      if (created) {
        const link = new URL("/reset-password", config.webAppUrl);
        link.searchParams.set("token", created.token);
        await mailer.send({
          to: email,
          subject: "Reset your Nexus password",
          text:
            `Someone (hopefully you) asked to reset the password on this account.\n\n${link.toString()}\n\n` +
            `This link expires in 1 hour and can only be used once. If you didn't request this, your password ` +
            `hasn't changed and you can ignore this email.`,
        });
      }
    } catch {
      // Still return the generic response -- a transient DB/mailer
      // error shouldn't leak account existence, and there's nothing the
      // caller could do differently with a more specific error here.
    }
    res.json(generic);
  });

  app.post("/auth/reset-password", async (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token) return res.status(400).json({ error: "Missing reset token." });
    if (password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: "Choose a password of at least 12 characters (up to 128)." });
    }
    try {
      const userId = await db.consumePasswordResetToken(token);
      if (!userId) return res.status(400).json({ error: "That reset link is invalid, expired, or already used. Request a new one." });
      await db.updatePasswordHash(userId, await hashPassword(password));
      // A password reset is exactly the moment a session anywhere else
      // (e.g. an attacker who had the old password) should stop being
      // valid -- sign out every device, not just the one doing the reset.
      await db.deleteSessionsForUser(userId);
      await issueSession(res, userId, config);
      res.json({ reset: true });
    } catch {
      res.status(503).json({ error: "Couldn't reset your password right now. Please try again." });
    }
  });
}
