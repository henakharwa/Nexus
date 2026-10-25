// Icons used across the workspace room. Kept together so the room's
// components read as layout and behavior rather than SVG paths.
import type { IntegrationConfig } from "@mai-chat/shared-types";
import type { AgentKind } from "./agents";

// Small inline "spark" glyph for the agent's avatar -- distinguishes it at
// a glance from a person's colored-initials circle without needing an
// image asset.
export function AgentGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z" fill="currentColor" />
    </svg>
  );
}
export function WorkspaceAgentGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="9" cy="13" r="1.4" fill="currentColor" />
      <circle cx="15" cy="13" r="1.4" fill="currentColor" />
      <path d="M12 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Same GitHub octocat / Slack four-color marks used on the Integrations
// settings page (apps/web/app/w/[id]/integrations/page.tsx) -- kept as
// their own small components here so the "connected channels" row in the
// sidebar below can show the same glyph a member would recognize from
// that page, without duplicating the two integration types' whole panels.
export function GithubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function SlackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z" fill="#e01e5a" />
      <path d="M9 6a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Z" fill="#36c5f0" />
      <path d="M18 9a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Z" fill="#2eb67d" />
      <path d="M15 18a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z" fill="#ecb22e" />
    </svg>
  );
}
export function BrandGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <ellipse cx="12" cy="12" rx="10" ry="4.4" stroke="#2F5FED" strokeWidth="1.7" transform="rotate(-30 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4.4" stroke="#8D70FF" strokeWidth="1.7" transform="rotate(30 12 12)" />
      <circle cx="12" cy="12" r="3.35" fill="#17244A" />
      <circle cx="19.35" cy="5.8" r="1.8" fill="#2F5FED" />
      <circle cx="4.65" cy="18.2" r="1.8" fill="#8D70FF" />
    </svg>
  );
}
export function LinearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 5.2 5.2 4 20 18.8 18.8 20 4 5.2Zm0 6.7L5.2 10.7 13.3 18.8 12.1 20 4 11.9Zm6.7-7.9L12 2.8 20 10.7l-1.2 1.2L10.7 4Z"
      />
    </svg>
  );
}
export function NotionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5.2 4.5 18.8 3.4l1.5 1.8v14.1l-1.7 1.2-13.4-.9-1.5-1.7V6.2l1.5-1.7Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M8 8.4v7.1m0-7.1 7.8 7.1m0-7.1v7.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
export function FigmaIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F24E1E" d="M8 2h4v4H8a2 2 0 1 1 0-4Z" />
      <path fill="#FF7262" d="M12 2h4a2 2 0 1 1 0 4h-4V2Z" />
      <path fill="#A259FF" d="M8 6h4v4H8a2 2 0 1 1 0-4Z" />
      <path fill="#1ABCFE" d="M12 6h4a2 2 0 1 1 0 4h-4V6Z" />
      <path fill="#0ACF83" d="M8 10h4v4a2 2 0 1 1-4 0v-4Z" />
    </svg>
  );
}
export function ToolIcon({ tool }: { tool: Exclude<IntegrationConfig["type"], "project"> }) {
  return tool === "github" ? (
    <GithubIcon />
  ) : tool === "slack" ? (
    <SlackIcon />
  ) : tool === "linear" ? (
    <LinearIcon />
  ) : tool === "notion" ? (
    <NotionIcon />
  ) : (
    <FigmaIcon />
  );
}
export function AgentIcon({ agent }: { agent: AgentKind }) {
  return (
    <span className={`agent-logo ${agent}`}>{agent === "project" ? <AgentGlyph /> : <ToolIcon tool={agent} />}</span>
  );
}
export function CustomAgentLogo({ name }: { name: string }) {
  const hue = Array.from(name).reduce((total, character) => total + character.charCodeAt(0), 0) % 360;
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "AI";
  return (
    <span
      className="agent-logo custom-agent-logo"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 72% 48%), hsl(${(hue + 44) % 360} 75% 61%))` }}
      aria-label={`${name} logo`}
    >
      {initials}
    </span>
  );
}
export function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function MoreGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="19" cy="12" r="1.7" fill="currentColor" />
    </svg>
  );
}
export function PlugGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M8 3v6m8-6v6M6 9h12v2a6 6 0 0 1-12 0V9Zm6 8v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function ChatGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v11H8l-4 3V5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
export function ActivityGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 12h4l2-6 4 12 2-6h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function GridGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
export function MemoryGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 4.5A2.5 2.5 0 0 0 3.5 7v10.5A2.5 2.5 0 0 1 6 15h4.5a2.5 2.5 0 0 1 2.5 2.5V7A2.5 2.5 0 0 0 10.5 4.5H6Zm12 0A2.5 2.5 0 0 1 20.5 7v10.5A2.5 2.5 0 0 0 18 15h-4.5a2.5 2.5 0 0 0-2.5 2.5V7a2.5 2.5 0 0 1 2.5-2.5H18Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function ObserveGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 18V6m5 12v-7m5 7V4m5 14v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 20h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function WorkflowGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="6" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 6h4a4 4 0 0 1 4 4M8 18h4a4 4 0 0 0 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function ShieldGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6l-7-2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="m9 12 2 2 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TasksGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="3.5" width="16" height="17" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="m7.5 9 1.5 1.5L11.5 7M13 9h4M7.5 15 9 16.5l2.5-3.5M13 15h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function ArtifactGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M14 3.5V8h4M9 12h6M9 16h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
export function ChevronGlyph({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={direction === "up" ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function LinkGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1L11 5m3 6a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 19.9L13 19"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function ArrowGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 12h13m-5-5 5 5-5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function SignOutGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M10 5H5v14h5m4-4 5-3-5-3m5 3H9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function BellGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M18 10a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 22h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function KeyGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="m11 12 8-8m-3 0h3v3m-6 3 2 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
