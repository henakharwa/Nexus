import type { WebSocket } from "ws";
import type { Participant } from "@mai-chat/shared-types";

interface Connection {
  ws: WebSocket;
  participant: Participant;
}

// Optional link to other chat-server processes (see realtime-bus.ts). With
// no bus, everything below stays in this process, which is all a single
// instance needs.
export type BusMessage =
  | { kind: "broadcast"; room: string; payload: unknown }
  | { kind: "presence"; room: string; instanceId: string; participants: Participant[] }
  | { kind: "disconnect_member"; room: string; userId: string; reason: string };
export interface RoomBus {
  readonly instanceId: string;
  publish(message: BusMessage): Promise<void>;
  subscribe(handler: (message: BusMessage) => void): void;
  tryLock(room: string, ttlSeconds: number): Promise<boolean>;
  unlock(room: string): Promise<void>;
  close(): Promise<void>;
}

const REMOTE_PRESENCE_TTL_MS = 90_000;
const AGENT_TURN_LOCK_SECONDS = 15 * 60;

// One room per workspace: the set of currently-connected WebSocket clients.
// Deliberately in-memory, not persisted -- presence is ephemeral, same
// distinction this project's prior build drew between Yjs Awareness
// (ephemeral) and Y.Doc content (persisted). Chat messages themselves are
// real rows in packages/db; who's online right now is not.
export class RoomRegistry {
  private rooms = new Map<string, Set<Connection>>();
  // Participants connected to OTHER processes, per room, as last reported.
  private remotePresence = new Map<string, Map<string, { participants: Participant[]; at: number }>>();

  constructor(private readonly bus?: RoomBus) {
    bus?.subscribe((message) => {
      if (message.kind === "broadcast") this.deliverLocal(message.room, message.payload);
      else if (message.kind === "disconnect_member") this.disconnectLocalMember(message.room, message.userId, message.reason);
      else if (message.instanceId !== bus.instanceId) {
        const byInstance = this.remotePresence.get(message.room) ?? new Map();
        byInstance.set(message.instanceId, { participants: message.participants, at: Date.now() });
        this.remotePresence.set(message.room, byInstance);
      }
    });
  }

  /** Re-announces this process's presence for every room (called on a heartbeat). */
  refreshPresence(): void {
    for (const room of this.rooms.keys()) this.publishPresence(room);
  }

  private localParticipants(room: string): Participant[] {
    const conns = this.rooms.get(room);
    return conns ? Array.from(conns).map((c) => c.participant) : [];
  }

  private publishPresence(room: string): void {
    if (!this.bus) return;
    void this.bus.publish({ kind: "presence", room, instanceId: this.bus.instanceId, participants: this.localParticipants(room) }).catch((error) => console.error("presence publish failed", error));
  }

  /**
   * Takes the one-agent-turn-at-a-time lock for a conversation. Shared
   * across processes when a bus is configured; otherwise in-memory.
   */
  async tryAcquireAgentTurn(room: string): Promise<boolean> {
    if (this.bus) {
      const acquired = await this.bus.tryLock(room, AGENT_TURN_LOCK_SECONDS);
      if (acquired) this.busyWorkspaces.add(room);
      return acquired;
    }
    if (this.busyWorkspaces.has(room)) return false;
    this.busyWorkspaces.add(room);
    return true;
  }

  async releaseAgentTurn(room: string): Promise<void> {
    this.busyWorkspaces.delete(room);
    if (this.bus) await this.bus.unlock(room);
  }
  // Workspaces where an agent turn (server.ts's runAgentReply) is
  // currently in flight -- the chat is multiplayer, but only one agent
  // turn should ever run at a time per workspace: it reads the full
  // message history and can propose mutating GitHub tool calls, so two
  // overlapping turns could read stale/interleaved history or double-fire
  // the same write. Tracked here, alongside the other ephemeral
  // (non-persisted) per-workspace room state.
  private busyWorkspaces = new Set<string>();

  isBusy(workspaceId: string): boolean {
    return this.busyWorkspaces.has(workspaceId);
  }

  setBusy(workspaceId: string, busy: boolean): void {
    if (busy) {
      this.busyWorkspaces.add(workspaceId);
    } else {
      this.busyWorkspaces.delete(workspaceId);
    }
  }

  // A second connection joining with the SAME displayName replaces the
  // earlier one instead of sitting alongside it in the presence list --
  // found live 2026-09-21: a duplicate "name (you)" row could briefly (or
  // not-so-briefly, before the heartbeat in server.ts got a chance to
  // prune it) show up from React StrictMode's dev-mode double-effect
  // invoke opening a second WebSocket before the first one's close
  // handshake finished, or a stale tab/connection left over from earlier
  // testing. The presence list is meant to answer "who's here", one row
  // per person, not one row per WebSocket that's ever connected. The
  // evicted connection is actually closed here (not just dropped from
  // tracking), so it can't linger as a zombie for the heartbeat to have
  // to clean up later, and its own "close" handler in server.ts still
  // runs normally (a harmless no-op re-broadcast, since it's already
  // gone from the room by then).
  join(workspaceId: string, ws: WebSocket, participant: Participant): void {
    let room = this.rooms.get(workspaceId);
    if (!room) {
      room = new Set();
      this.rooms.set(workspaceId, room);
    }
    for (const conn of room) {
      if ((conn.participant.userId ?? conn.participant.displayName) === (participant.userId ?? participant.displayName) && conn.ws !== ws) {
        room.delete(conn);
        if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CONNECTING) {
          conn.ws.close(4008, "replaced by a new connection with the same name");
        }
      }
    }
    room.add({ ws, participant });
    this.publishPresence(workspaceId);
  }

  leave(workspaceId: string, ws: WebSocket): void {
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    for (const conn of room) {
      if (conn.ws === ws) {
        room.delete(conn);
        break;
      }
    }
    if (room.size === 0) this.rooms.delete(workspaceId);
    this.publishPresence(workspaceId);
  }

  /** Immediately removes every local socket a member has open in a workspace. */
  disconnectMember(workspaceId: string, userId: string, reason: string): void {
    this.disconnectLocalMember(workspaceId, userId, reason);
    if (this.bus)
      void this.bus
        .publish({ kind: "disconnect_member", room: workspaceId, userId, reason })
        .catch((error) => console.error("member disconnect publish failed", error));
  }

  private disconnectLocalMember(workspaceId: string, userId: string, reason: string): void {
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    for (const conn of room) {
      if (conn.participant.userId !== userId) continue;
      room.delete(conn);
      if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CONNECTING)
        conn.ws.close(4009, reason);
    }
    if (room.size === 0) this.rooms.delete(workspaceId);
    this.publishPresence(workspaceId);
  }

  participants(workspaceId: string): Participant[] {
    const local = this.localParticipants(workspaceId);
    const remote = this.remotePresence.get(workspaceId);
    if (!remote) return local;
    const now = Date.now();
    const merged = [...local];
    const seen = new Set(local.map((p) => p.userId ?? p.displayName));
    for (const [instanceId, entry] of remote) {
      if (now - entry.at > REMOTE_PRESENCE_TTL_MS) { remote.delete(instanceId); continue; }
      for (const participant of entry.participants) {
        const key = participant.userId ?? participant.displayName;
        if (!seen.has(key)) { seen.add(key); merged.push(participant); }
      }
    }
    return merged;
  }

  /** Sends to this process's sockets and, with a bus, to every other process. */
  broadcast(workspaceId: string, payload: unknown, exclude?: WebSocket): void {
    this.deliverLocal(workspaceId, payload, exclude);
    if (this.bus) void this.bus.publish({ kind: "broadcast", room: workspaceId, payload }).catch((error) => console.error("realtime publish failed", error));
  }

  private deliverLocal(workspaceId: string, payload: unknown, exclude?: WebSocket): void {
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    const data = JSON.stringify(payload);
    for (const conn of room) {
      if (conn.ws === exclude) continue;
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(data);
      }
    }
  }
}
