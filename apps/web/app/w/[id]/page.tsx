"use client";

// The workspace room: the shared conversation, its sidebar and the approval
// cards. The pieces live in ./_room; this file holds the room's state and
// wires them together.
import { useEffect, useRef, useState } from "react";
import { useDialog } from "../../_components/DialogProvider";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type {
  Conversation,
  IntegrationConfig,
  Workspace,
  WorkspaceAgent,
  WorkspaceMember,
  WorkspaceRole,
} from "@mai-chat/shared-types";
import {
  ApiError,
  createConversation,
  deleteConversation,
  deleteWorkspace,
  describeError,
  disconnectIntegration,
  getWorkspace,
  githubOAuthStartUrl,
  leaveWorkspace,
  listConversations,
  listIntegrations,
  listWorkspaceAgents,
  listWorkspaceMembers,
  updateConversation,
} from "../../../lib/api";
import { useWorkspaceChat } from "../../../lib/useWorkspaceChat";
import ConnectChannelModal from "../../_components/ConnectChannelModal";
import GithubRepoPickerModal from "../../_components/GithubRepoPickerModal";
import { useWorkspaceUser } from "../../_components/WorkspaceAuth";
import { TeamActivityStrip } from "../../_components/TeamAwareness";
import { AccessNotice } from "../../_components/AccessNotice";
import { useWorkspaceAccess } from "../../../lib/useWorkspaceAccess";
import EmailVerificationBanner from "../../_components/EmailVerificationBanner";
import { draftLooksLikeHandoff } from "../../../lib/mentionHighlight";
import { AGENTS, type AgentKind } from "./_room/agents";
import AccessManager from "./_room/AccessManager";
import AccountBar from "./_room/AccountBar";
import { ChatComposer, EmptyConversation, type ComposerProps } from "./_room/Composer";
import ConnectedTools from "./_room/ConnectedTools";
import ConversationList from "./_room/ConversationList";
import { BrandGlyph, LinkGlyph, PlugGlyph, PlusGlyph, SearchGlyph } from "./_room/glyphs";
import InviteModal from "./_room/InviteModal";
import MembersPanel from "./_room/MembersPanel";
import MessageList from "./_room/MessageList";
import NotificationsMenu from "./_room/NotificationsMenu";
import PendingActionsPanel from "./_room/PendingActionsPanel";
import PermissionRequestsMenu from "./_room/PermissionRequestsMenu";
import RoomToasts, { type RoomNotice } from "./_room/RoomToasts";
import { usePermissionRequests } from "./_room/usePermissionRequests";
import { useRoomNotifications } from "./_room/useRoomNotifications";
import WorkspaceNav from "./_room/WorkspaceNav";

export default function WorkspaceRoomPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;
  const router = useRouter();
  const dialog = useDialog();
  const user = useWorkspaceUser();
  const access = useWorkspaceAccess(workspaceId);
  const displayName = user.displayName;
  const greetingName = (displayName || user.username || "there").trim().split(/\s+/)[0] || "there";

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentKind>("project");
  const [configuredAgent, setConfiguredAgent] = useState<WorkspaceAgent | null>(null);
  const [workspaceAgents, setWorkspaceAgents] = useState<WorkspaceAgent[]>([]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [showAccessManager, setShowAccessManager] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [githubNotice, setGithubNotice] = useState<RoomNotice | null>(null);
  const [slackNotice, setSlackNotice] = useState<RoomNotice | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);

  const chat = useWorkspaceChat(workspace ? workspaceId : null, selectedConversationId, displayName);
  const notifications = useRoomNotifications(workspaceId, chat, conversations, selectedConversationId);
  // Role comes from the server's effective access, never a client default,
  // so Admin-only controls are not shown before access has loaded.
  const workspaceRole: WorkspaceRole | null =
    access.role ?? workspaceMembers.find((member) => member.id === user.id)?.role ?? null;
  const isAdmin = workspaceRole === "admin";
  const permissionRequests = usePermissionRequests(workspaceId, isAdmin, setLoadError);

  // Opening the room with ?agentId=... preselects that published agent.
  useEffect(() => {
    const agentId = new URLSearchParams(window.location.search).get("agentId");
    if (!agentId) return;
    listWorkspaceAgents(workspaceId)
      .then((agents) => {
        const agent = agents.find((item) => item.id === agentId && item.status === "published") ?? null;
        if (agent) {
          setConfiguredAgent(agent);
          setSelectedAgent(agent.baseAgent);
        }
      })
      .catch(() => {});
  }, [workspaceId]);

  // A live socket is deliberately closed after a role or membership change.
  // When the member chooses Reconnect, refresh the HTTP-backed room state as
  // well; otherwise the socket has the new access while the page still shows
  // the old members, role controls, and error state until a manual reload.
  useEffect(() => {
    if (chat.reconnectVersion === 0) return;
    let cancelled = false;
    Promise.all([
      getWorkspace(workspaceId),
      listWorkspaceMembers(workspaceId),
      listConversations(workspaceId),
      listIntegrations(workspaceId),
    ])
      .then(([nextWorkspace, members, nextConversations, nextIntegrations]) => {
        if (cancelled) return;
        setWorkspace(nextWorkspace);
        setWorkspaceMembers(members);
        setConversations(nextConversations);
        setIntegrations(nextIntegrations);
        setLoadError(null);
        access.refresh();
      })
      .catch((err) => {
        if (!cancelled)
          setLoadError(
            err instanceof ApiError && err.status === 403
              ? "You are not a member of this workspace. Join it with its join code or ask an Admin for an invitation."
              : describeError(err, "Could not refresh this workspace."),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [access.refresh, chat.reconnectVersion, workspaceId]);

  useEffect(() => {
    listWorkspaceAgents(workspaceId)
      .then(setWorkspaceAgents)
      .catch(() => {});
  }, [workspaceId]);

  function refreshIntegrations() {
    listIntegrations(workspaceId)
      .then(setIntegrations)
      .catch(() => {});
  }

  // The GitHub and Slack OAuth flows (services/chat-server/src/github-oauth.ts
  // and slack-oauth.ts) always return the browser to /w/:id with a status
  // in the query string. Read it once, then strip it so a refresh doesn't
  // repeat it. Best-effort: the rest of the room doesn't depend on it.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const github = query.get("github");
    const slack = query.get("slack");
    if (!github && !slack) return;
    if (github === "connected") {
      setShowRepoPicker(true);
    } else if (github === "error") {
      setGithubNotice({ kind: "error", text: query.get("githubMessage") ?? "GitHub login failed." });
    }
    if (slack === "connected") {
      setSlackNotice({ kind: "success", text: "Slack connected -- the agent can now read and post to it." });
      refreshIntegrations();
    } else if (slack === "error") {
      setSlackNotice({ kind: "error", text: query.get("slackMessage") ?? "Slack login failed." });
    }
    router.replace(`/w/${workspaceId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    getWorkspace(workspaceId)
      .then((ws) => {
        if (!cancelled) setWorkspace(ws);
      })
      .catch((err) => {
        if (!cancelled)
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? "Workspace not found."
              : err instanceof ApiError && err.status === 403
                ? "You are not a member of this workspace. Join it with its join code or ask an Admin for an invitation."
                : describeError(err, "Could not load this workspace."),
          );
      });
    listIntegrations(workspaceId)
      .then((list) => {
        if (!cancelled) setIntegrations(list);
      })
      .catch(() => {});
    listConversations(workspaceId)
      .then((list) => {
        if (cancelled) return;
        setConversations(list);
        const requested = new URLSearchParams(window.location.search).get("conversation");
        setSelectedConversationId(list.some((item) => item.id === requested) ? requested : (list[0]?.id ?? null));
      })
      .catch(() => {});
    listWorkspaceMembers(workspaceId)
      .then((members) => {
        if (!cancelled) setWorkspaceMembers(members);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // A teammate connecting a tool isn't broadcast over the WebSocket, so
  // everyone else's sidebar picks it up by polling every 5 seconds. Whoever
  // connected it sees it at once through refreshIntegrations().
  useEffect(() => {
    const interval = setInterval(refreshIntegrations, 5_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages.length]);

  async function removeIntegration(integration: IntegrationConfig) {
    try {
      await disconnectIntegration(workspaceId, integration);
      setIntegrations((current) => current.filter((item) => item.id !== integration.id));
    } catch (err) {
      setGithubNotice({ kind: "error", text: describeError(err, "Could not disconnect this tool.") });
    }
  }

  async function leaveCurrentWorkspace() {
    const confirmed = await dialog.confirm({
      title: "Leave this workspace?",
      message:
        "Your personal connected tools will be removed. You can rejoin later with the join code or a new invitation.",
      confirmLabel: "Leave workspace",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await leaveWorkspace(workspaceId);
      router.replace("/");
    } catch (err) {
      setLoadError(describeError(err, "Could not leave the workspace."));
    }
  }

  async function deleteCurrentWorkspace() {
    const confirmed = await dialog.confirm({
      title: `Delete ${workspace?.name ?? "this workspace"}?`,
      message:
        "This permanently removes every conversation, member, integration, workflow, memory entry, artifact, and audit record in this workspace.",
      confirmLabel: "Delete workspace",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteWorkspace(workspaceId);
      router.replace("/");
    } catch (err) {
      setLoadError(describeError(err, "Could not delete the workspace."));
    }
  }

  async function startNewConversation(): Promise<void> {
    try {
      const conversation = await createConversation(workspaceId);
      setConversations((current) => [conversation, ...current]);
      setSelectedConversationId(conversation.id);
      setConversationSearch("");
      setDraft("");
      window.history.replaceState(null, "", `/w/${workspaceId}?conversation=${conversation.id}`);
      window.setTimeout(() => composerInputRef.current?.focus(), 0);
    } catch {
      setLoadError("Could not create a new conversation.");
    }
  }

  function selectConversation(conversationId: string): void {
    setSelectedConversationId(conversationId);
    setConversationSearch("");
    setDraft("");
    window.history.replaceState(null, "", `/w/${workspaceId}?conversation=${conversationId}`);
  }

  async function removeConversation(conversation: Conversation): Promise<void> {
    const confirmed = await dialog.confirm({
      title: `Delete “${conversation.title}”?`,
      message: "This permanently removes its messages and pending approvals.",
      confirmLabel: "Delete conversation",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const remaining = await deleteConversation(workspaceId, conversation.id);
      setConversations(remaining);
      const nextConversation = remaining.find((item) => item.id !== conversation.id) ?? remaining[0];
      if (nextConversation) selectConversation(nextConversation.id);
    } catch (err) {
      setLoadError(describeError(err, "Could not delete this conversation."));
    }
  }

  async function changeConversation(
    conversation: Conversation,
    input: { title?: string; pinned?: boolean; archived?: boolean },
  ): Promise<void> {
    try {
      const updated = await updateConversation(workspaceId, conversation.id, input);
      setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setLoadError(describeError(error, "Could not update this conversation."));
    }
  }

  async function renameConversation(conversation: Conversation): Promise<void> {
    const title = (
      await dialog.prompt({
        title: "Rename conversation",
        label: "Conversation name",
        defaultValue: conversation.title,
        confirmLabel: "Rename",
        maxLength: 100,
      })
    )?.trim();
    if (title && title !== conversation.title) void changeConversation(conversation, { title });
  }

  // A draft that clearly @-mentions only a teammate is a hand-off, which
  // the server never blocks on the agent being busy (see
  // draftLooksLikeHandoff), so the composer doesn't either.
  const draftIsHandoff = draftLooksLikeHandoff(
    draft,
    chat.participants.map((p) => p.displayName),
  );

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || (chat.agentBusy && !draftIsHandoff)) return;
    if (selectedConversationId) {
      const title = draft.trim().slice(0, 80);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === selectedConversationId && conversation.title === "New conversation"
            ? { ...conversation, title }
            : conversation,
        ),
      );
    }
    chat.sendMessage(draft, selectedAgent, configuredAgent?.id);
    setDraft("");
  }

  const visibleMessages = conversationSearch.trim()
    ? chat.messages.filter((message) =>
        `${message.authorName} ${message.content}`.toLowerCase().includes(conversationSearch.trim().toLowerCase()),
      )
    : chat.messages;
  const isNewWorkspaceConversation = chat.messages.length === 0;
  const selectedAgentInfo = configuredAgent
    ? { ...(AGENTS.find((agent) => agent.id === selectedAgent) ?? AGENTS[0]), name: configuredAgent.name }
    : (AGENTS.find((agent) => agent.id === selectedAgent) ?? AGENTS[0]);
  const canEdit = workspaceRole === "admin" || workspaceRole === "editor";
  const canConnectTools = access.can("connectTools");
  const canUseSelectedProvider =
    selectedAgent === "project" || access.can(selectedAgent as "github" | "slack" | "linear" | "notion" | "figma");
  const selectedAgentConnected =
    selectedAgent === "project" || integrations.some((integration) => integration.type === selectedAgent);
  const chatOpen = chat.status === "open";
  const pendingActions = chat.pendingActions.filter((action) => action.status === "pending");
  const onboardingSteps = [
    { label: "Create your workspace", complete: true },
    {
      label: "Invite a teammate",
      complete: workspaceMembers.length > 1,
      action: isAdmin ? () => setShowInviteModal(true) : undefined,
    },
    {
      label: "Connect a tool",
      complete: integrations.length > 0,
      action: canConnectTools ? () => setShowConnectModal(true) : undefined,
    },
    {
      label: "Ask an agent a question",
      complete: conversations.some(
        (conversation) => conversation.id === selectedConversationId && chat.messages.length > 0,
      ),
    },
  ];

  const blockedByAgent = chat.agentBusy && !draftIsHandoff;
  const composer: ComposerProps = {
    draft,
    onDraftChange: setDraft,
    inputRef: composerInputRef,
    onSubmit: handleSend,
    inputDisabled: !chatOpen || !canEdit,
    sendDisabled: !chatOpen || !canEdit || !draft.trim(),
    agentSelector: {
      selected: selectedAgent,
      selectedName: selectedAgentInfo.name,
      customName: configuredAgent?.name,
      customAgents: workspaceAgents.filter((agent) => agent.status === "published"),
      selectedCustomId: configuredAgent?.id,
      open: agentPickerOpen,
      onToggle: () => setAgentPickerOpen((open) => !open),
      onSelect: (agent) => {
        setSelectedAgent(agent);
        setConfiguredAgent(null);
        setAgentPickerOpen(false);
      },
      onSelectCustom: (agent) => {
        setConfiguredAgent(agent);
        setSelectedAgent(agent.baseAgent);
        setAgentPickerOpen(false);
      },
    },
    starterPrompts: {
      agent: selectedAgent,
      agentName: selectedAgentInfo.name,
      connected: selectedAgentConnected,
      canEdit,
      chatOpen,
      canConnect: canConnectTools,
      onConnect: () => setShowConnectModal(true),
      onChoose: (prompt) => {
        setDraft(prompt);
        window.setTimeout(() => composerInputRef.current?.focus(), 0);
      },
    },
  };

  if (loadError) {
    return (
      <div className="page">
        <div className="card">
          <p className="error-text" data-testid="room-load-error">
            {loadError}
          </p>
          <Link className="btn secondary" href="/" style={{ display: "block", textAlign: "center", marginTop: 14 }}>
            Back home
          </Link>
        </div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="page">
        <p style={{ color: "var(--text-dim)" }}>Loading workspace…</p>
      </div>
    );
  }

  return (
    <div className="workspace-shell">
      <EmailVerificationBanner user={user} />
      <RoomToasts
        reconnecting={chat.reconnecting}
        closeReason={chat.status === "closed" ? chat.closeReason : null}
        onReconnect={chat.reconnect}
        githubNotice={githubNotice}
        slackNotice={slackNotice}
        onDismissGithub={() => setGithubNotice(null)}
        onDismissSlack={() => setSlackNotice(null)}
      />

      {showConnectModal && <ConnectChannelModal workspaceId={workspaceId} onClose={() => setShowConnectModal(false)} />}
      {showRepoPicker && (
        <GithubRepoPickerModal
          workspaceId={workspaceId}
          onClose={() => setShowRepoPicker(false)}
          onSelected={() => {
            setShowRepoPicker(false);
            refreshIntegrations();
          }}
        />
      )}
      {showInviteModal && (
        <InviteModal
          workspaceId={workspaceId}
          workspaceName={workspace.name}
          onClose={() => setShowInviteModal(false)}
        />
      )}

      <aside className="workspace-sidebar">
        <div className="workspace-sidebar-top">
          <Link href="/" className="workspace-brand" aria-label="Nexus home">
            <BrandGlyph />
            <span>Nexus</span>
          </Link>
          <div className="workspace-sidebar-icons">
            <NotificationsMenu
              notifications={notifications.visible}
              unreadCount={notifications.unreadCount}
              onOpened={notifications.markAllRead}
              onClear={notifications.clear}
            />
            {isAdmin && (
              <PermissionRequestsMenu
                requests={permissionRequests.requests}
                onDecide={(request, decision) => void permissionRequests.decide(request, decision)}
              />
            )}
            {canConnectTools && (
              <button
                type="button"
                title="Workspace integrations"
                onClick={() => setShowConnectModal(true)}
                aria-label="Add integration"
              >
                <PlugGlyph />
              </button>
            )}
          </div>
        </div>
        <div className="workspace-sidebar-scroll">
          <div className="workspace-search">
            <SearchGlyph />
            <input
              value={conversationSearch}
              onChange={(event) => setConversationSearch(event.target.value)}
              placeholder="Search this conversation"
              aria-label="Search this conversation"
            />
          </div>
          <button className="workspace-new" onClick={startNewConversation}>
            <PlusGlyph /> New chat
          </button>
          <WorkspaceNav workspaceId={workspaceId} />
          <ConversationList
            conversations={conversations}
            selectedConversationId={selectedConversationId}
            unreadConversationIds={chat.unreadConversationIds}
            canEdit={canEdit}
            isAdmin={isAdmin}
            onSelect={selectConversation}
            onRename={(conversation) => void renameConversation(conversation)}
            onUpdate={(conversation, input) => void changeConversation(conversation, input)}
            onDelete={(conversation) => void removeConversation(conversation)}
          />
          <ConnectedTools
            workspaceId={workspaceId}
            integrations={integrations}
            currentUserId={user.id}
            canConnectTools={canConnectTools}
            onConnect={() => setShowConnectModal(true)}
            onChangeGithub={() => {
              window.location.href = githubOAuthStartUrl(workspaceId);
            }}
            onDisconnect={removeIntegration}
          />
          <MembersPanel
            participants={chat.workspaceParticipants}
            displayName={displayName}
            selectedConversationId={selectedConversationId}
            role={workspaceRole}
            onManage={() => setShowAccessManager(true)}
            onFollow={selectConversation}
          />
        </div>
        <AccountBar displayName={displayName} username={user.username} role={workspaceRole} />
      </aside>

      <main className="workspace-main" id="conversation">
        <header className="workspace-main-header">
          <div>
            <p className="workspace-kicker">Shared workspace</p>
            <h1>{workspace.name}</h1>
          </div>
          <div className="workspace-header-actions">
            {isAdmin && (
              <>
                <button className="workspace-invite" onClick={() => setShowInviteModal(true)}>
                  <LinkGlyph /> Invite teammates
                </button>
                <button className="workspace-invite" onClick={() => setShowAccessManager(true)}>
                  Manage access
                </button>
                <button className="workspace-invite workspace-leave" onClick={() => void leaveCurrentWorkspace()}>
                  Leave workspace
                </button>
                <button className="workspace-invite workspace-leave" onClick={() => void deleteCurrentWorkspace()}>
                  Delete workspace
                </button>
              </>
            )}
          </div>
        </header>

        <section className="workspace-overview" aria-label="Workspace overview">
          <div>
            <span>Team</span>
            <strong>
              {workspaceMembers.length || 1} {workspaceMembers.length === 1 ? "member" : "members"}
            </strong>
          </div>
          <div>
            <span>Tools</span>
            <strong>{integrations.length ? `${integrations.length} connected` : "None connected"}</strong>
          </div>
          <div>
            <span>Conversations</span>
            <strong>
              {conversations.length || 1} {conversations.length === 1 ? "chat" : "chats"}
            </strong>
          </div>
          <Link href={`/w/${workspaceId}/integrations`} className="workspace-overview-link">
            Manage tools →
          </Link>
        </section>

        <TeamActivityStrip activity={chat.teamActivity} />

        <div className="workspace-chat-scroll" data-testid="message-list">
          {isNewWorkspaceConversation ? (
            <EmptyConversation {...composer} greetingName={greetingName} onboardingSteps={onboardingSteps} />
          ) : (
            <MessageList
              messages={visibleMessages}
              currentUserId={user.id}
              displayName={displayName}
              participantNames={chat.participants.map((p) => p.displayName)}
            />
          )}
          {conversationSearch && visibleMessages.length === 0 && (
            <p className="workspace-no-results">No messages match “{conversationSearch}”.</p>
          )}
          <div ref={messagesEndRef} />
        </div>

        {!canUseSelectedProvider && (
          <AccessNotice
            workspaceId={workspaceId}
            access={access}
            permission={selectedAgent as "github" | "slack" | "linear" | "notion" | "figma"}
            message={`Your workspace role cannot use the ${selectedAgentInfo.name} provider in chat or workflows.`}
          />
        )}
        <PendingActionsPanel
          workspaceId={workspaceId}
          actions={pendingActions}
          actorName={displayName}
          currentUserId={user.id}
          canApprove={access.can("approveActions")}
          access={access}
        />

        {chat.agentBusy && (
          <div className="agent-busy-note" data-testid="agent-busy-note">
            The agent is working on the previous request…
          </div>
        )}
        {chat.sendError && (
          <div className="agent-busy-note error" data-testid="send-error-note">
            {chat.sendError}
          </div>
        )}

        {!isNewWorkspaceConversation && (
          <ChatComposer
            {...composer}
            inputDisabled={composer.inputDisabled || blockedByAgent}
            sendDisabled={composer.sendDisabled || blockedByAgent}
            workspaceName={workspace.name}
            placeholder={
              !chatOpen
                ? "Connecting…"
                : blockedByAgent
                  ? "Waiting for the agent to finish… (or @mention a teammate to hand this off now)"
                  : "Message the workspace… (@mention the agent or a teammate)"
            }
          />
        )}
        {showAccessManager && (
          <AccessManager
            workspaceId={workspaceId}
            members={workspaceMembers}
            onClose={() => setShowAccessManager(false)}
            onChanged={setWorkspaceMembers}
          />
        )}
      </main>
    </div>
  );
}
