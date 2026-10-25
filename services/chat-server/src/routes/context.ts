// Shared context handed to every route module by createApp.
import type { Express, Request, Response } from "express";
import type { WorkspacePermissions } from "@mai-chat/shared-types";
import type { CreateServerDeps } from "../server-deps.js";

export interface RouteContext {
  app: Express;
  deps: CreateServerDeps;
  /** The web app's origin, without a trailing slash. */
  webAppUrl: string;
  /** Workspace guard: 400 malformed id, 404 unknown workspace, 403 wrong role. */
  requireRole(req: Request, res: Response, allowed: Array<"admin" | "editor">): Promise<boolean>;
  /** Same guard, but checks a saved permission (Admins hold all). */
  requirePermission(req: Request, res: Response, permission: keyof WorkspacePermissions): Promise<boolean>;
  /** Ends live sockets after an Admin changes or removes a member. */
  disconnectWorkspaceMember?(workspaceId: string, userId: string, reason: string): void;
}
