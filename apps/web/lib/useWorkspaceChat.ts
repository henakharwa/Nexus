"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, Participant, PendingAction, TeamActivity } from "@mai-chat/shared-types";
import { CHAT_SERVER_WS_URL } from "./config";
import { listMessages, listPendingActions, listTeamActivity } from "./api";

export type ConnectionStatus = "connecting" | "open" | "closed";

interface ServerEvent {
  type:
    | "history"
    | "message"
    | "workspace_message"
    | "presence"
    | "workspace_presence"
    | "error"
    | "pending_action"
    | "pending_action_update"
    | "agent_status"
    | "team_activity";
  messages?: ChatMessage[];
  message?: ChatMessage;
  participants?: Participant[];
  error?: string;
  action?: PendingAction;
  status?: "busy" | "idle";
  activity?: TeamActivity;
}

export interface WorkspaceChatState {
  status: ConnectionStatus;
  messages: ChatMessage[];
  participants: Participant[];
  workspaceParticipants: Participant[];
  unreadConversationIds: string[];
  pendingActions: PendingAction[];
  closeReason: string | null;
  reconnecting: boolean;
  // True while the agent is actively working on the last message sent in
  // this workspace (by anyone -- the room shares one agent turn at a
  // time, see services/chat-server/src/server.ts). The composer should
  // disable sending while this is true rather than let a new prompt queue
  // up behind one still in flight.
  agentBusy: boolean;
  // The server's reason for rejecting the most recent send attempt (e.g. a
  // message that raced in while the agent was still busy). Cleared on the
  // next successful send.
  sendError: string | null;
  historyLoaded: boolean;
  /** Increments after a live socket reconnects (not on the initial load). */
  reconnectVersion: number;
  // What teammates' agents and GitHub did recently in this workspace,
  // newest first; updated live.
  teamActivity: TeamActivity[];
  sendMessage: (
    content: string,
    agentKind?: "project" | "github" | "slack" | "linear" | "notion" | "figma",
    agentId?: string,
  ) => void;
  reconnect: () => void;
}

// One WebSocket per (workspaceId, displayName), reconnected on demand via
// `reconnect()` rather than automatically -- an unexpected close (server
// restart, network blip) surfaces as a visible "disconnected" banner with
// a button, matching services/chat-server's close codes 4000/4004 which
// are deliberate rejections, not transient failures worth silently
// retrying.
export function useWorkspaceChat(
  workspaceId: string | null,
  conversationId: string | null,
  displayName: string | null,
): WorkspaceChatState {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [workspaceParticipants, setWorkspaceParticipants] = useState<Participant[]>([]);
  const [unreadConversationIds, setUnreadConversationIds] = useState<string[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [teamActivity, setTeamActivity] = useState<TeamActivity[]>([]);
  const [generation, setGeneration] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const connectedOnceRef = useRef(false);
  const connectionKeyRef = useRef<string | null>(null);
  const [reconnectVersion, setReconnectVersion] = useState(0);

  useEffect(() => {
    if (!workspaceId || !conversationId || !displayName) return;
    let active = true;
    const connectionKey = `${workspaceId}:${conversationId}:${displayName}`;
    if (connectionKeyRef.current !== connectionKey) {
      connectionKeyRef.current = connectionKey;
      connectedOnceRef.current = false;
    }
    setStatus("connecting");
    setCloseReason(null);
    setMessages([]);
    setParticipants([]);
    setPendingActions([]);
    setAgentBusy(false);
    setSendError(null);
    setHistoryLoaded(false);

    // Fetch persisted history as soon as this conversation is selected. The
    // WebSocket also sends history and remains the live update channel, but
    // this fallback makes a refresh/reconnect resilient if that one socket
    // event is delayed or lost through a proxy restart.
    listMessages(workspaceId, conversationId)
      .then((stored) => {
        if (!active) return;
        setMessages(stored);
        setHistoryLoaded(true);
      })
      .catch(() => {
        // The socket can still supply history; keep the composer disabled
        // only until one of the two sources succeeds.
      });

    // The WebSocket's "history" event only replays chat messages -- any
    // GitHub actions still awaiting confirmation from before this visit
    // (e.g. proposed while everyone was away) are fetched separately here,
    // then kept live via the pending_action/pending_action_update events
    // below.
    listPendingActions(workspaceId, conversationId)
      .then(setPendingActions)
      .catch(() => {
        // Non-fatal -- worst case, a still-pending action from before this
        // page load doesn't show up until the next agent turn touches it.
      });

    const url = `${CHAT_SERVER_WS_URL}/ws?workspaceId=${encodeURIComponent(workspaceId)}&conversationId=${encodeURIComponent(conversationId)}`;
    const ws = new WebSocket(url);
    socketRef.current = ws;

    ws.onopen = () => {
      if (connectedOnceRef.current) setReconnectVersion((version) => version + 1);
      connectedOnceRef.current = true;
      setStatus("open");
      setReconnecting(false);
    };

    ws.onmessage = (event) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed.type === "history" && parsed.messages) {
        setMessages(parsed.messages);
        setHistoryLoaded(true);
      } else if (parsed.type === "message" && parsed.message) {
        setMessages((prev) => [...prev, parsed.message as ChatMessage]);
      } else if (parsed.type === "workspace_message" && parsed.message) {
        const message = parsed.message as ChatMessage;
        if (message.conversationId !== conversationId)
          setUnreadConversationIds((current) =>
            current.includes(message.conversationId) ? current : [...current, message.conversationId],
          );
      } else if (parsed.type === "presence" && parsed.participants) {
        setParticipants(parsed.participants);
      } else if (parsed.type === "workspace_presence" && parsed.participants) {
        setWorkspaceParticipants(parsed.participants);
      } else if (parsed.type === "pending_action" && parsed.action) {
        const incoming = parsed.action;
        setPendingActions((prev) => [...prev.filter((a) => a.id !== incoming.id), incoming]);
      } else if (parsed.type === "pending_action_update" && parsed.action) {
        const updated = parsed.action;
        setPendingActions((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      } else if (parsed.type === "team_activity" && parsed.activity) {
        const incoming = parsed.activity;
        setTeamActivity((current) => mergeActivity(current, [incoming]));
      } else if (parsed.type === "agent_status" && parsed.status) {
        setAgentBusy(parsed.status === "busy");
      } else if (parsed.type === "error" && parsed.error) {
        setSendError(parsed.error);
      }
    };

    ws.onclose = (event) => {
      setStatus("closed");
      setReconnecting(false);
      if (event.code === 4001) {
        window.location.reload();
        return;
      }
      // 4008 is a different socket connecting with the same displayName
      // evicting this one (see rooms.ts's join()) -- show the server's own
      // reason text rather than the generic "connection was lost" message,
      // since it's a deliberate replacement, not a dropped connection.
      if (event.code === 4000 || event.code === 4004 || event.code === 4008) {
        setCloseReason(event.reason || "connection rejected");
      } else if (event.code !== 1000) {
        setCloseReason("disconnected -- the connection was lost");
      }
    };

    return () => {
      active = false;
      ws.close();
      socketRef.current = null;
    };
  }, [workspaceId, conversationId, displayName, generation]);

  // Team activity belongs to the workspace, not one conversation.
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    setTeamActivity([]);
    listTeamActivity(workspaceId)
      .then((items) => {
        if (active) setTeamActivity((live) => mergeActivity(live, items));
      })
      .catch(() => {
        // Optional context; the chat works without it.
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (conversationId) setUnreadConversationIds((current) => current.filter((id) => id !== conversationId));
  }, [conversationId]);

  const sendMessage = useCallback(
    (
      content: string,
      agentKind: "project" | "github" | "slack" | "linear" | "notion" | "figma" = "project",
      agentId?: string,
    ) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setSendError("Your connection is offline. Reconnect before sending a message.");
        return;
      }
      setSendError(null);
      ws.send(JSON.stringify({ type: "chat", content: trimmed, agentKind, agentId }));
    },
    [],
  );

  const reconnect = useCallback(() => {
    setReconnecting(true);
    setSendError(null);
    setGeneration((g) => g + 1);
  }, []);

  return {
    status,
    messages,
    participants,
    workspaceParticipants,
    unreadConversationIds,
    pendingActions,
    closeReason,
    reconnecting,
    agentBusy,
    sendError,
    historyLoaded,
    reconnectVersion,
    teamActivity,
    sendMessage,
    reconnect,
  };
}

/** Newest first, one entry per id, at most 20. */
function mergeActivity(current: TeamActivity[], incoming: TeamActivity[]): TeamActivity[] {
  const byId = new Map<string, TeamActivity>();
  for (const item of [...incoming, ...current]) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20);
}
