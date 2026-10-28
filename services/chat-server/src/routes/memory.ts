// Workspace memory entries and the Admin review queue for memory changes.
//
// Memory is injected into every agent turn, so it is a prompt-injection
// surface (Security Validation scope 11). Admins change memory directly;
// anyone else holding "Manage workspace memory" proposes a change that only
// reaches agents after an Admin approves it.
import * as db from "@mai-chat/db";
import type { WorkspaceMemoryProposal, WorkspaceMemoryProposalStatus } from "@mai-chat/shared-types";
import { errMessage, paramString } from "../http-utils.js";
import { parseWorkspaceMemoryInput } from "../input-parsers.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

const PROPOSAL_STATUSES: WorkspaceMemoryProposalStatus[] = ["pending", "approved", "rejected", "withdrawn"];
const ACTION_VERBS = { create: "add", update: "edit", delete: "delete" } as const;

export function registerMemoryRoutes({ app, requireRole, requirePermission }: RouteContext): void {
  function readInput(req: Request, res: Response) {
    let input;
    try {
      input = parseWorkspaceMemoryInput(req.body ?? {});
    } catch (error) {
      res.status(400).json({ error: errMessage(error) });
      return null;
    }
    if (!input.title.trim() || !input.content.trim()) {
      res.status(400).json({ error: "A memory title and content are required." });
      return null;
    }
    if (input.title.length > 200 || input.content.length > 20_000) {
      res.status(400).json({ error: "Memory titles can be up to 200 characters and content up to 20,000." });
      return null;
    }
    return input;
  }

  async function isAdmin(req: Request): Promise<boolean> {
    return (await db.getWorkspaceRole(paramString(req.params.id), req.user!.id)) === "admin";
  }

  // Records the proposal, tells every Admin it is waiting, and answers 202 so
  // the caller knows nothing has reached agents yet.
  async function propose(req: Request, res: Response, result: db.CreateMemoryProposalResult) {
    if (!result.ok) {
      if (result.reason === "not_found") return res.status(404).json({ error: "Memory not found." });
      return res.status(409).json({ error: "You already have a change waiting for review on this entry. Withdraw it first to propose a new one." });
    }
    const { proposal } = result;
    const workspaceId = proposal.workspaceId;
    const verb = ACTION_VERBS[proposal.action];
    await db.recordAuditEvent({
      workspaceId,
      eventType: "memory.change_proposed",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} proposed to ${verb} memory ${proposal.title}`,
      metadata: { proposalId: proposal.id, action: proposal.action, memoryId: proposal.memoryId },
    });
    const admins = (await db.listWorkspaceMembersWithRoles(workspaceId)).filter((member) => member.role === "admin");
    await Promise.all(
      admins.map((admin) =>
        db.notifyWorkspaceUser({
          workspaceId,
          userId: admin.id,
          kind: "decision_needed",
          text: `${req.user!.displayName} proposed to ${verb} workspace memory "${proposal.title}". Review it on the Memory page.`,
        }),
      ),
    );
    return res.status(202).json({ status: "pending_review", proposal });
  }

  app.get("/workspaces/:id/memory", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceMemory(paramString(req.params.id)));
  });

  app.post("/workspaces/:id/memory", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "manageMemory"))) return;
    const input = readInput(req, res);
    if (!input) return;
    const workspaceId = paramString(req.params.id);
    if (!(await isAdmin(req))) {
      return propose(req, res, await db.createMemoryProposal({ workspaceId, action: "create", change: input, proposedByUserId: req.user!.id }));
    }
    const memory = await db.createWorkspaceMemory({ workspaceId, ...input, createdByUserId: req.user!.id });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.created", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} saved ${memory.kind} memory ${memory.title}` });
    res.status(201).json(memory);
  });

  app.patch("/workspaces/:id/memory/:memoryId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "manageMemory"))) return;
    const workspaceId = paramString(req.params.id);
    const memoryId = paramString(req.params.memoryId);
    if (!(await db.getWorkspaceMemory(workspaceId, memoryId))) return res.status(404).json({ error: "Memory not found." });
    const input = readInput(req, res);
    if (!input) return;
    if (!(await isAdmin(req))) {
      return propose(req, res, await db.createMemoryProposal({ workspaceId, action: "update", memoryId, change: input, proposedByUserId: req.user!.id }));
    }
    const memory = await db.updateWorkspaceMemory(workspaceId, memoryId, input);
    if (!memory) return res.status(404).json({ error: "Memory not found." });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} updated memory ${memory.title}` });
    res.json(memory);
  });

  app.delete("/workspaces/:id/memory/:memoryId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "manageMemory"))) return;
    const workspaceId = paramString(req.params.id);
    const memoryId = paramString(req.params.memoryId);
    if (!(await db.getWorkspaceMemory(workspaceId, memoryId))) return res.status(404).json({ error: "Memory not found." });
    if (!(await isAdmin(req))) {
      return propose(req, res, await db.createMemoryProposal({ workspaceId, action: "delete", memoryId, proposedByUserId: req.user!.id }));
    }
    const memory = await db.deleteWorkspaceMemory(workspaceId, memoryId);
    if (!memory) return res.status(404).json({ error: "Memory not found." });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.deleted", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} deleted memory ${memory.title}` });
    res.status(204).end();
  });

  // Admins see the whole queue; everyone else sees only their own proposals.
  app.get("/workspaces/:id/memory/proposals", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && !PROPOSAL_STATUSES.includes(status as WorkspaceMemoryProposalStatus))
      return res.status(400).json({ error: "Status must be pending, approved, rejected or withdrawn." });
    res.json(
      await db.listMemoryProposals(paramString(req.params.id), {
        status: status as WorkspaceMemoryProposalStatus | undefined,
        proposedByUserId: (await isAdmin(req)) ? undefined : req.user!.id,
      }),
    );
  });

  app.post("/workspaces/:id/memory/proposals/:proposalId/:decision", async (req: Request, res: Response) => {
    const decision = paramString(req.params.decision);
    if (decision === "withdraw") return withdraw(req, res);
    if (decision !== "approve" && decision !== "reject") return res.status(404).json({ error: "not found" });
    if (!(await requireRole(req, res, ["admin"]))) return;
    const note = typeof req.body?.note === "string" ? req.body.note : null;
    if (note && note.length > 500) return res.status(400).json({ error: "Review notes can be up to 500 characters." });
    const workspaceId = paramString(req.params.id);
    const result = await db.reviewMemoryProposal({ workspaceId, proposalId: paramString(req.params.proposalId), decision, reviewerUserId: req.user!.id, note });
    if (!result.ok) {
      const refusals = {
        not_found: [404, "Proposal not found."],
        not_pending: [409, "This proposal has already been reviewed or withdrawn."],
        outdated: [409, "The entry changed after this was proposed. Reject it and ask for a new proposal against the current version."],
        self_review: [403, "Another Admin must review a change you proposed."],
      } as const;
      const [status, error] = refusals[result.reason];
      return res.status(status).json({ error });
    }
    const { proposal, memory } = result;
    const verb = ACTION_VERBS[proposal.action];
    const proposer = proposal.proposedByName ?? "a former member";
    await db.recordAuditEvent({
      workspaceId,
      eventType: decision === "approve" ? "memory.change_approved" : "memory.change_rejected",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} ${decision === "approve" ? "approved" : "rejected"} ${proposer}'s proposal to ${verb} memory ${proposal.title}`,
      metadata: { proposalId: proposal.id, action: proposal.action, memoryId: memory?.id ?? proposal.memoryId, proposedByUserId: proposal.proposedByUserId },
    });
    if (decision === "approve") {
      const applied = { create: "memory.created", update: "memory.updated", delete: "memory.deleted" } as const;
      await db.recordAuditEvent({
        workspaceId,
        eventType: applied[proposal.action],
        actorType: "user",
        actorUserId: req.user!.id,
        actorName: req.user!.displayName,
        summary: `${proposal.action === "delete" ? "Deleted" : proposal.action === "update" ? "Updated" : "Saved"} memory ${proposal.title} (proposed by ${proposer}, approved by ${req.user!.displayName})`,
        metadata: { proposalId: proposal.id },
      });
    }
    if (proposal.proposedByUserId) {
      await db.notifyWorkspaceUser({
        workspaceId,
        userId: proposal.proposedByUserId,
        kind: "decision_needed",
        text:
          decision === "approve"
            ? `${req.user!.displayName} approved your change to memory "${proposal.title}". Agents use it now.`
            : `${req.user!.displayName} rejected your change to memory "${proposal.title}".${proposal.reviewNote ? ` Note: ${proposal.reviewNote}` : ""}`,
      });
    }
    res.json({ proposal, memory });
  });

  async function withdraw(req: Request, res: Response) {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const proposal = await db.withdrawMemoryProposal(workspaceId, paramString(req.params.proposalId), req.user!.id);
    if (!proposal) {
      const existing = await db.getMemoryProposal(workspaceId, paramString(req.params.proposalId));
      if (!existing) return res.status(404).json({ error: "Proposal not found." });
      if (existing.proposedByUserId !== req.user!.id) return res.status(403).json({ error: "Only the person who proposed a change can withdraw it." });
      return res.status(409).json({ error: "This proposal has already been reviewed or withdrawn." });
    }
    await db.recordAuditEvent({
      workspaceId,
      eventType: "memory.change_withdrawn",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} withdrew their proposal to ${ACTION_VERBS[proposal.action]} memory ${proposal.title}`,
      metadata: { proposalId: proposal.id },
    });
    res.json(proposal satisfies WorkspaceMemoryProposal);
  }
}
