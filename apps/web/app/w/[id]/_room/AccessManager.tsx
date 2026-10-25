"use client";

import { useEffect, useState } from "react";
import type { WorkspaceMember, WorkspaceRole } from "@mai-chat/shared-types";
import { useDialog } from "../../../_components/DialogProvider";
import {
  describeError,
  getWorkspaceJoinPolicy,
  listWorkspaceJoinRequests,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  removeWorkspaceMember,
  resolveWorkspaceJoinRequest,
  revokeWorkspaceInvitation,
  sendWorkspaceInvitation,
  updateWorkspaceJoinPolicy,
  updateWorkspaceMemberRole,
  type WorkspaceJoinRequest,
} from "../../../../lib/api";
import { colorForName, initialsForName } from "../../../../lib/avatar";
import { CloseGlyph } from "./glyphs";

// Admin dialog: change members' roles, remove members, manage invitations.
export default function AccessManager({
  workspaceId,
  members,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  members: WorkspaceMember[];
  onClose: () => void;
  onChanged: (members: WorkspaceMember[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<
    Array<{ id: string; email: string; role: WorkspaceRole; expiresAt: string }>
  >([]);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [joinRequests, setJoinRequests] = useState<WorkspaceJoinRequest[]>([]);
  const [savingJoinPolicy, setSavingJoinPolicy] = useState(false);
  const dialog = useDialog();
  useEffect(() => {
    Promise.all([
      listWorkspaceInvitations(workspaceId),
      getWorkspaceJoinPolicy(workspaceId),
      listWorkspaceJoinRequests(workspaceId),
    ])
      .then(([nextInvitations, policy, requests]) => {
        setInvitations(nextInvitations);
        setApprovalRequired(policy.approvalRequired);
        setJoinRequests(requests);
      })
      .catch(() => {});
  }, [workspaceId]);

  async function changeJoinPolicy(required: boolean) {
    setSavingJoinPolicy(true);
    setError(null);
    try {
      await updateWorkspaceJoinPolicy(workspaceId, required);
      setApprovalRequired(required);
    } catch (err) {
      setError(describeError(err, "Could not update the join policy."));
    } finally {
      setSavingJoinPolicy(false);
    }
  }

  async function decideJoinRequest(request: WorkspaceJoinRequest, decision: "approve" | "deny") {
    try {
      await resolveWorkspaceJoinRequest(workspaceId, request.id, decision);
      setJoinRequests((current) => current.filter((item) => item.id !== request.id));
      if (decision === "approve") onChanged(await listWorkspaceMembers(workspaceId));
    } catch (err) {
      setError(describeError(err, `Could not ${decision} this join request.`));
    }
  }
  async function changeRole(member: WorkspaceMember, role: WorkspaceRole) {
    try {
      await updateWorkspaceMemberRole(workspaceId, member.id, role);
      onChanged(members.map((item) => (item.id === member.id ? { ...item, role } : item)));
    } catch (err) {
      setError(describeError(err, "Could not change role."));
    }
  }
  async function removeMember(member: WorkspaceMember) {
    if (
      !(await dialog.confirm({
        title: `Remove ${member.displayName}?`,
        message: "They lose access to this workspace and their personal tool connections are removed.",
        confirmLabel: "Remove member",
        danger: true,
      }))
    )
      return;
    try {
      await removeWorkspaceMember(workspaceId, member.id);
      onChanged(members.filter((item) => item.id !== member.id));
    } catch (err) {
      setError(describeError(err, "Could not remove member."));
    }
  }
  async function revokeInvitation(invitationId: string) {
    try {
      await revokeWorkspaceInvitation(workspaceId, invitationId);
      setInvitations((current) => current.filter((item) => item.id !== invitationId));
    } catch (err) {
      setError(describeError(err, "Could not revoke invitation."));
    }
  }
  async function resendInvitation(invite: { id: string; email: string; role: WorkspaceRole }) {
    try {
      await sendWorkspaceInvitation(workspaceId, { email: invite.email, role: invite.role });
      await revokeWorkspaceInvitation(workspaceId, invite.id);
      setInvitations(await listWorkspaceInvitations(workspaceId));
    } catch (err) {
      setError(describeError(err, "Could not resend invitation."));
    }
  }
  return (
    <div className="access-modal-backdrop" role="presentation">
      <section className="access-modal" role="dialog" aria-modal="true" aria-label="Manage workspace access">
        <header>
          <div>
            <p>Workspace access</p>
            <h2>Members and roles</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <CloseGlyph />
          </button>
        </header>
        <p className="access-modal-intro">
          Admins manage access and approve write actions. Editors can connect tools and work with agents.
        </p>
        {error && <p className="error-text">{error}</p>}
        <div className="access-member-list">
          {members.map((member) => (
            <div className="access-member" key={member.id}>
              <span className="avatar" style={{ background: colorForName(member.displayName) }}>
                {initialsForName(member.displayName)}
              </span>
              <strong>
                {member.displayName}
                <small>{member.email ?? member.username}</small>
              </strong>
              <select
                value={member.role}
                onChange={(event) => void changeRole(member, event.target.value as WorkspaceRole)}
                aria-label={`Role for ${member.displayName}`}
              >
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
              </select>
              <button className="access-remove" type="button" onClick={() => void removeMember(member)}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <section className="access-join-policy">
          <div>
            <h3>Join-code access</h3>
            <p>Require an Admin to approve every new join-code request. Email invitations still work immediately.</p>
          </div>
          <label className="access-toggle">
            <input
              type="checkbox"
              checked={approvalRequired}
              disabled={savingJoinPolicy}
              onChange={(event) => void changeJoinPolicy(event.target.checked)}
            />
            Require approval
          </label>
        </section>
        <section className="access-invitations access-join-requests">
          <h3>Join-code requests</h3>
          {joinRequests.length ? (
            joinRequests.map((joinRequest) => (
              <div key={joinRequest.id}>
                <span>
                  <strong>{joinRequest.displayName}</strong>
                  <small>{joinRequest.email ?? "No email address"}</small>
                </span>
                <aside>
                  <button type="button" onClick={() => void decideJoinRequest(joinRequest, "approve")}>
                    Approve
                  </button>
                  <button type="button" onClick={() => void decideJoinRequest(joinRequest, "deny")}>
                    Deny
                  </button>
                </aside>
              </div>
            ))
          ) : (
            <p>No pending join-code requests.</p>
          )}
        </section>
        <section className="access-invitations">
          <h3>Pending invitations</h3>
          {invitations.length ? (
            invitations.map((invite) => (
              <div key={invite.id}>
                <span>
                  <strong>{invite.email}</strong>
                  <small>
                    {invite.role} · expires {new Date(invite.expiresAt).toLocaleDateString()}
                  </small>
                </span>
                <aside>
                  <button type="button" onClick={() => void resendInvitation(invite)}>
                    Resend
                  </button>
                  <button type="button" onClick={() => void revokeInvitation(invite.id)}>
                    Revoke
                  </button>
                </aside>
              </div>
            ))
          ) : (
            <p>No pending invitations.</p>
          )}
        </section>
      </section>
    </div>
  );
}
