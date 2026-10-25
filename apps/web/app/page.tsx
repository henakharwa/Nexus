"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  describeError,
  acceptWorkspaceInvitation,
  createWorkspace,
  joinWorkspaceByCode,
  listMyWorkspaces,
  ApiError,
} from "../lib/api";
import type { Workspace, WorkspaceMembership } from "@mai-chat/shared-types";
import BrandMark from "./_components/Logo";
import { useCurrentUser } from "../lib/useCurrentUser";
import { logout } from "../lib/api";
import AuthDialog from "./_components/AuthDialog";
import EmailVerificationBanner from "./_components/EmailVerificationBanner";

export default function HomePage() {
  const router = useRouter();
  const auth = useCurrentUser();
  const [authMode, setAuthMode] = useState<"signin" | "signup" | null>(null);
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinRequestPending, setJoinRequestPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingWorkspace, setExistingWorkspace] = useState<Workspace | null>(null);
  const [myWorkspaces, setMyWorkspaces] = useState<WorkspaceMembership[]>([]);
  const [workspacesState, setWorkspacesState] = useState<"loading" | "ready" | "error">("loading");
  const [workspacesVersion, setWorkspacesVersion] = useState(0);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState("");
  const inviteHandled = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setName(params.get("workspaceName") ?? "");
    setJoinCode(params.get("joinCode") ?? "");
    setInviteToken(params.get("invite") ?? "");
    if (params.get("loginError")) {
      setError(params.get("loginError"));
      setAuthMode("signin");
    }
  }, []);

  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-scroll-reveal]"));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14 },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!auth.user || !inviteToken || inviteHandled.current) return;
    inviteHandled.current = true;
    acceptWorkspaceInvitation(inviteToken)
      .then(({ workspaceId }) => router.replace(`/w/${workspaceId}`))
      .catch((err) => setError(describeError(err, "Could not accept this invitation.")));
  }, [auth.user, inviteToken, router]);

  useEffect(() => {
    if (!auth.user) {
      setMyWorkspaces([]);
      return;
    }
    setWorkspacesState("loading");
    listMyWorkspaces()
      .then((list) => {
        setMyWorkspaces(list);
        setWorkspacesState("ready");
      })
      .catch(() => {
        setMyWorkspaces([]);
        setWorkspacesState("error");
      });
  }, [auth.user, workspacesVersion]);

  async function copyJoinCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      window.setTimeout(() => setCopiedCode((current) => (current === code ? null : current)), 1500);
    } catch {
      /* clipboard unavailable; the code stays visible */
    }
  }

  const returnParams = new URLSearchParams();
  if (name) returnParams.set("workspaceName", name);
  if (joinCode) returnParams.set("joinCode", joinCode);
  if (inviteToken) returnParams.set("invite", inviteToken);
  const returnTo = returnParams.size ? `/?${returnParams}` : "/";

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!auth.user) {
      setAuthMode("signin");
      return;
    }
    setCreating(true);
    setError(null);
    setExistingWorkspace(null);
    try {
      const workspace = await createWorkspace(name.trim());
      router.push(`/w/${workspace.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        auth.refresh();
        setAuthMode("signin");
      }
      if (err instanceof ApiError && err.status === 409 && err.workspace) setExistingWorkspace(err.workspace);
      setError(describeError(err, "Could not create the workspace. Is the chat server running?"));
      setCreating(false);
    }
  }

  // Opening a workspace that already exists joins it first (as an Editor
  // for new members) so the workspace page loads with real access.
  async function openExistingWorkspace(workspace: Workspace) {
    setError(null);
    try {
      const joined = workspace.joinCode ? await joinWorkspaceByCode(workspace.joinCode) : workspace;
      if ("pending" in joined) {
        setError("Your request to join is pending an Admin's approval.");
        return;
      }
      router.push(`/w/${joined.id}`);
    } catch (err) {
      setError(describeError(err, "Something went wrong. Try again."));
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!joinCode.trim()) return;
    if (!auth.user) {
      setAuthMode("signin");
      return;
    }
    setJoining(true);
    setError(null);
    setJoinRequestPending(false);
    try {
      const workspace = await joinWorkspaceByCode(joinCode.trim());
      if ("pending" in workspace) {
        setJoinRequestPending(true);
        setJoining(false);
        return;
      }
      router.push(`/w/${workspace.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        auth.refresh();
        setAuthMode("signin");
      }
      setError(describeError(err, "Could not join this workspace."));
      setJoining(false);
    }
  }

  return (
    <div className="home-shell home-background-slate home-motion-calm">
      <nav className="home-nav">
        <BrandMark />
        {!auth.user && (
          <div className="marketing-nav">
            <a href="#how-it-works">How it works</a>
            <a href="#product">Product</a>
            <a href="#security">Security</a>
            <a href="#faq">FAQ</a>
          </div>
        )}
        <div className="auth-nav">
          {auth.user ? (
            <>
              <span className="account-name">{auth.user.displayName}</span>
              <button
                className="auth-nav-button"
                onClick={async () => {
                  await logout();
                  auth.refresh();
                }}
              >
                Sign Out
              </button>
            </>
          ) : (
            <>
              <button
                className="auth-nav-button"
                onClick={() => {
                  setError(null);
                  setAuthMode("signup");
                }}
                data-testid="sign-up-btn"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <circle cx="9" cy="7" r="4" />
                  <path d="M2 21v-2a7 7 0 0 1 14 0v2M19 8v6m-3-3h6" />
                </svg>
                Sign Up
              </button>
              <button
                className="auth-nav-button primary"
                onClick={() => {
                  setError(null);
                  setAuthMode("signin");
                }}
                data-testid="sign-in-btn"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="M14 4h6v16h-6M3 12h12m-4-4 4 4-4 4" />
                </svg>
                Sign In
              </button>
            </>
          )}
        </div>
      </nav>
      {authMode && <AuthDialog mode={authMode} returnTo={returnTo} error={error} onClose={() => setAuthMode(null)} />}
      {auth.user && <EmailVerificationBanner user={auth.user} />}

      <div className="home-hero">
        <span className="eyebrow">Shared AI workspace</span>
        <h1>Your team&apos;s AI work, governed and visible from idea to outcome.</h1>
        <p className="lede">
          Connect your tools, run governed workflows, preserve the context that matters, and see every outcome,
          approval, and operational signal in one shared workspace.
        </p>

        {!auth.user && (
          <div className="home-primary-actions">
            <div className="hero-cta-row">
              <button
                className="btn home-primary-cta"
                onClick={() => {
                  setError(null);
                  setAuthMode("signup");
                }}
              >
                Create your workspace
              </button>
              <button
                className="marketing-secondary-cta"
                type="button"
                onClick={() => document.getElementById("demo")?.scrollIntoView({ behavior: "smooth" })}
              >
                Watch demo
              </button>
            </div>
            <button
              className="home-text-action"
              onClick={() => {
                setError(null);
                setAuthMode("signin");
              }}
            >
              Already have an account? Sign in
            </button>
          </div>
        )}

        <div className={`home-panels${auth.user ? " home-panels-signed-in" : ""}`}>
          {auth.user && (
            <section className="home-panel home-workspaces" data-testid="my-workspaces">
              <div className="home-workspaces-header">
                <div>
                  <p>Your workspaces</p>
                  <h2>Pick up where your team left off</h2>
                </div>
                <span>
                  {myWorkspaces.length} {myWorkspaces.length === 1 ? "workspace" : "workspaces"}
                </span>
              </div>
              <p className="panel-hint">
                Every workspace you belong to, as an Admin or an Editor. Share a join code to bring teammates in.
              </p>
              {workspacesState === "loading" ? (
                <p className="panel-hint">Loading your workspaces…</p>
              ) : workspacesState === "error" ? (
                <p className="error-text">
                  Could not load your workspaces.{" "}
                  <button
                    type="button"
                    className="home-workspace-retry"
                    onClick={() => setWorkspacesVersion((value) => value + 1)}
                  >
                    Try again
                  </button>
                </p>
              ) : myWorkspaces.length === 0 ? (
                <p className="home-workspace-empty">
                  You are not part of any workspace yet. Create one or join with a code.
                </p>
              ) : (
                <div className="home-workspace-list">
                  {myWorkspaces.map((workspace) => (
                    <article key={workspace.id}>
                      <div className="home-workspace-details">
                        <strong>
                          {workspace.name}{" "}
                          <em className={`home-workspace-role ${workspace.role}`}>
                            {workspace.role === "admin" ? "Admin" : "Editor"}
                          </em>
                        </strong>
                        <span>
                          Join code: <code>{workspace.joinCode}</code>{" "}
                          <button
                            type="button"
                            className="home-workspace-copy"
                            onClick={() => void copyJoinCode(workspace.joinCode)}
                            aria-label={`Copy join code for ${workspace.name}`}
                          >
                            {copiedCode === workspace.joinCode ? "Copied" : "Copy"}
                          </button>
                        </span>
                      </div>
                      <button
                        className="btn secondary home-workspace-open"
                        type="button"
                        onClick={() => router.push(`/w/${workspace.id}`)}
                      >
                        Open workspace
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {auth.user && (
            <div className="home-panel">
              <span className="panel-icon blue" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </span>
              <h2>Start a new workspace</h2>
              <p className="panel-hint">
                Spin up a fresh shared space for your team and get a join code to invite others.
              </p>
              <form onSubmit={handleCreate}>
                <div className="field">
                  <label htmlFor="workspace-name">Workspace name</label>
                  <input
                    id="workspace-name"
                    data-testid="workspace-name-input"
                    placeholder="Acme Engineering"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <button
                  className="btn"
                  type="submit"
                  data-testid="create-workspace-btn"
                  disabled={auth.status === "loading" || creating || !name.trim()}
                >
                  {creating ? "Creating…" : "Create workspace"}
                </button>
              </form>
              {existingWorkspace && (
                <section className="home-existing-workspace" aria-live="polite">
                  <strong>{existingWorkspace.name} already exists</strong>
                  <span>
                    Join code: <code>{existingWorkspace.joinCode}</code>
                  </span>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => void openExistingWorkspace(existingWorkspace)}
                  >
                    Open workspace
                  </button>
                </section>
              )}
            </div>
          )}

          {auth.user && (
            <div className="home-panel">
              <span className="panel-icon violet" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 12a8 8 0 1 1 3.2 6.4L4 19l0.9-3A8 8 0 0 1 4 12Z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <h2>Join an existing one</h2>
              <p className="panel-hint">
                Already have a join code from a teammate? Drop in and pick up the conversation.
              </p>
              <form onSubmit={handleJoin}>
                <div className="field">
                  <label htmlFor="join-code">Join code</label>
                  <input
                    id="join-code"
                    data-testid="join-code-input"
                    placeholder="e.g. bright-otter-42"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <button
                  className="btn secondary"
                  type="submit"
                  data-testid="join-workspace-btn"
                  disabled={auth.status === "loading" || joining || !joinCode.trim()}
                >
                  {joining ? "Joining…" : "Join workspace"}
                </button>
              </form>
              {joinRequestPending && (
                <p className="panel-hint" role="status">
                  Your request is pending an Admin&apos;s approval. You can return once it has been approved.
                </p>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="home-error">
            <p className="error-text" data-testid="home-error">
              {error}
            </p>
          </div>
        )}
      </div>
      {!auth.user && (
        <main className="marketing-content">
          <section data-scroll-reveal className="marketing-proof" aria-label="Product benefits">
            <div>
              <strong>Shared context</strong>
              <span>Memory, artifacts, and conversations in one workspace</span>
            </div>
            <div>
              <strong>Governed execution</strong>
              <span>Agents and workflows propose; your team decides</span>
            </div>
            <div>
              <strong>Operational visibility</strong>
              <span>Runs, costs, diagnostics, and retention in one console</span>
            </div>
            <div>
              <strong>Connected work</strong>
              <span>GitHub, Slack, Linear, Notion, and Figma</span>
            </div>
          </section>
          <section data-scroll-reveal id="how-it-works" className="marketing-section marketing-steps">
            <p className="marketing-kicker">How it works</p>
            <h2>Three steps. One shared workspace.</h2>
            <div>
              {[
                [
                  "01",
                  "Create or join a workspace",
                  "Give your team one home for conversations, decisions, and connected work.",
                ],
                ["02", "Connect your tools", "Link GitHub, Slack, Linear, Notion, or Figma when you are ready."],
                [
                  "03",
                  "Ask, review, approve",
                  "Agents bring context together and wait for human approval before write actions.",
                ],
              ].map(([number, title, copy]) => (
                <article key={number}>
                  <span>{number}</span>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </article>
              ))}
            </div>
          </section>
          <section data-scroll-reveal id="demo" className="marketing-demo">
            <div>
              <p className="marketing-kicker">Interactive product preview</p>
              <h2>See the decision before it changes anything.</h2>
              <p>
                Agents gather context from connected tools, present a clear proposal, and keep the final decision with
                your team.
              </p>
              <button
                className="btn marketing-demo-cta"
                onClick={() => {
                  setError(null);
                  setAuthMode("signup");
                }}
              >
                Try it in your workspace
              </button>
            </div>
            <div className="marketing-demo-preview">
              <div className="marketing-demo-video">
                <video
                  controls
                  controlsList="nodownload nofullscreen noremoteplayback"
                  disablePictureInPicture
                  preload="metadata"
                  poster="/brag.jpg"
                  aria-label="Nexus product demo"
                >
                  <source src="/brag.mp4" type="video/mp4" />
                  Your browser does not support embedded videos.
                </video>
              </div>
              <article className="marketing-demo-approval" aria-label="Example approval card">
                <header>
                  <span>GitHub agent</span>
                  <small>Approval required</small>
                </header>
                <h3>Create issue: Improve empty-state guidance</h3>
                <p>
                  Target: <b>acme/web-app</b> · Nothing has changed yet.
                </p>
                <footer>
                  <button type="button">Review proposal</button>
                  <button type="button">Approve</button>
                </footer>
              </article>
            </div>
          </section>
          <section data-scroll-reveal id="product" className="marketing-section">
            <p className="marketing-kicker">Designed around outcomes</p>
            <h2>Keep work moving without losing control.</h2>
            <div className="marketing-outcomes">
              <article>
                <span>⌘</span>
                <h3>Run repeatable work</h3>
                <p>Create manual, scheduled, GitHub, and Slack-triggered workflows with governed execution.</p>
              </article>
              <article>
                <span>↗</span>
                <h3>Turn discussion into decisions</h3>
                <p>Bring team updates into one place, create artifacts, and make the next step visible to everyone.</p>
              </article>
              <article>
                <span>⌕</span>
                <h3>Keep context current</h3>
                <p>Use workspace memory, connected knowledge, tasks, and design context where work happens.</p>
              </article>
              <article>
                <span>✓</span>
                <h3>Review every external change</h3>
                <p>Agents prepare the work; authorized teammates retain control over approvals and access.</p>
              </article>
            </div>
          </section>
          <section data-scroll-reveal className="marketing-section marketing-observability">
            <p className="marketing-kicker">Execution you can explain</p>
            <h2>See how work ran, what it used, and what needs attention.</h2>
            <div>
              <article>
                <span>◌</span>
                <h3>Run-level detail</h3>
                <p>
                  Inspect input, tool steps, output, latency, provider-reported tokens, and cost for every workflow run.
                </p>
              </article>
              <article>
                <span>⌁</span>
                <h3>Connected diagnostics</h3>
                <p>
                  Track integration health, grouped failures, trends, and retention policies without leaving the
                  workspace.
                </p>
              </article>
              <article>
                <span>●</span>
                <h3>Notifications that lead somewhere</h3>
                <p>Search, group, prioritize, and act on approvals and workflow alerts from one notification center.</p>
              </article>
            </div>
          </section>
          <section data-scroll-reveal className="marketing-comparison">
            <div>
              <p className="marketing-kicker">More than a chat window</p>
              <h2>AI collaboration built for a real team.</h2>
            </div>
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Typical AI chat</th>
                  <th>Nexus</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Context</th>
                  <td>One person&apos;s prompt</td>
                  <td>Shared conversations and connected tools</td>
                </tr>
                <tr>
                  <th>Decisions</th>
                  <td>Live outside the chat</td>
                  <td>Visible approvals and activity history</td>
                </tr>
                <tr>
                  <th>Actions</th>
                  <td>Manual follow-up</td>
                  <td>Proposed work with human confirmation</td>
                </tr>
                <tr>
                  <th>Collaboration</th>
                  <td>Copy and paste updates</td>
                  <td>Teammate mentions and handoffs</td>
                </tr>
              </tbody>
            </table>
          </section>
          <section data-scroll-reveal id="security" className="marketing-section marketing-safety">
            <p className="marketing-kicker">Control by design</p>
            <h2>Agents propose. Your team approves.</h2>
            <div>
              <article>
                <h3>Approval before writes</h3>
                <p>External changes remain pending until an authorized teammate approves them.</p>
              </article>
              <article>
                <h3>Workspace roles</h3>
                <p>Admins manage people and permissions; editors collaborate with agents and tools.</p>
              </article>
              <article>
                <h3>Visible activity trail</h3>
                <p>See what was requested, what happened, and who approved each completed action.</p>
              </article>
            </div>
          </section>
          <section data-scroll-reveal className="marketing-section marketing-activity">
            <div>
              <p className="marketing-kicker">A workspace that explains itself</p>
              <h2>Progress your whole team can see.</h2>
              <p>
                Connected tools, active teammates, recent conversations, pending approvals, and completed actions are
                visible from the workspace instead of being hidden in private chats.
              </p>
            </div>
            <article>
              <span>Workspace overview</span>
              <strong>3 connected tools</strong>
              <strong>2 pending approvals</strong>
              <strong>12 conversations</strong>
              <small>Everything important is one click away.</small>
            </article>
          </section>
          <section data-scroll-reveal id="faq" className="marketing-section marketing-faq">
            <p className="marketing-kicker">Questions, answered</p>
            <h2>Start with the work your team already has.</h2>
            <details open>
              <summary>What can agents do in a workspace?</summary>
              <p>
                They can summarize connected context, answer questions, prepare work, and propose supported write
                actions for human approval.
              </p>
            </details>
            <details>
              <summary>Can teammates collaborate in the same conversation?</summary>
              <p>
                Yes. Workspace conversations are shared, teammates can be mentioned, and actions include a visible audit
                trail.
              </p>
            </details>
            <details>
              <summary>How are external changes controlled?</summary>
              <p>
                Write actions are displayed as pending proposals. An authorized workspace admin must approve them before
                they run.
              </p>
            </details>
            <details>
              <summary>Which tools can I connect?</summary>
              <p>GitHub, Slack, Linear, Notion, and Figma are available from the workspace integration flow.</p>
            </details>
          </section>
          <section data-scroll-reveal className="marketing-final-cta">
            <p className="marketing-kicker">Ready when your team is</p>
            <h2>Bring your tools, teammates, and decisions into one shared workspace.</h2>
            <button
              className="btn"
              onClick={() => {
                setError(null);
                setAuthMode("signup");
              }}
            >
              Create your workspace
            </button>
          </section>
        </main>
      )}
    </div>
  );
}
