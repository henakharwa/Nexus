"use client";

import { useState } from "react";
import type { WorkspaceRole } from "@mai-chat/shared-types";
import { describeError, listAccountSessions, logout, revokeOtherAccountSessions, type AccountSession } from "../../../../lib/api";
import { colorForName, initialsForName } from "../../../../lib/avatar";
import { SignOutGlyph } from "./glyphs";

// The signed-in member at the bottom of the sidebar, with sign-out.
export default function AccountBar({
  displayName,
  username,
  role,
}: {
  displayName: string;
  username: string;
  role: WorkspaceRole | null;
}) {
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [status, setStatus] = useState("");

  async function openSessions() {
    setSessionsOpen(true);
    setStatus("");
    try {
      setSessions(await listAccountSessions());
    } catch (error) {
      setStatus(describeError(error, "Could not load your active sessions."));
    }
  }

  async function revokeOthers() {
    setStatus("");
    try {
      const revoked = await revokeOtherAccountSessions();
      setSessions(await listAccountSessions());
      setStatus(revoked ? `Signed out ${revoked} other session${revoked === 1 ? "" : "s"}.` : "No other active sessions to sign out.");
    } catch (error) {
      setStatus(describeError(error, "Could not sign out other sessions."));
    }
  }

  return (
    <>
    <div className="workspace-account">
      <span className="workspace-account-avatar" style={{ background: colorForName(displayName) }}>
        {initialsForName(displayName)}
      </span>
      <span>
        <strong>
          {displayName}
          {role && (
            <span className={`workspace-role-badge ${role}`} data-testid="account-role-badge">
              {role === "admin" ? "Admin" : "Editor"}
            </span>
          )}
        </strong>
        <small>{username}</small>
      </span>
      <button onClick={openSessions} aria-label="Security and sessions" title="Security and sessions">⌁</button>
      <button
        onClick={async () => {
          await logout();
          window.location.href = "/";
        }}
        aria-label="Sign out"
        title="Sign out"
      >
        <SignOutGlyph />
      </button>
    </div>
    {sessionsOpen && (
      <div className="app-dialog-backdrop" role="presentation" onMouseDown={() => setSessionsOpen(false)}>
        <section className="app-dialog account-sessions-dialog" role="dialog" aria-modal="true" aria-labelledby="sessions-title" onMouseDown={(event) => event.stopPropagation()}>
          <h2 id="sessions-title">Security & sessions</h2>
          <p>Review where you are signed in. Signing out other sessions keeps this browser active.</p>
          {sessions ? (
            <ul className="account-session-list">
              {sessions.map((session, index) => (
                <li key={`${session.createdAt}-${index}`}>
                  <strong>{session.current ? "This browser" : "Other session"}</strong>
                  <small>Started {new Date(session.createdAt).toLocaleString()} · expires {new Date(session.expiresAt).toLocaleDateString()}</small>
                </li>
              ))}
            </ul>
          ) : !status ? <p>Loading sessions…</p> : null}
          {status && <p className="auth-error" role="status">{status}</p>}
          <div className="app-dialog-actions">
            <button className="btn secondary" type="button" onClick={() => setSessionsOpen(false)}>Close</button>
            <button className="btn" type="button" onClick={revokeOthers} disabled={!sessions}>Sign out other sessions</button>
          </div>
        </section>
      </div>
    )}
    </>
  );
}
