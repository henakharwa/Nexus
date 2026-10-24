"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// A persistent nav bar for every page under /w/[id]/* other than the chat
// page itself (which already has its own full sidebar, including this
// same set of links, in page.tsx -- see workspace-nav there). Before this
// existed, Agents/Artifacts/Audit/Integrations/Memory/Workflows were each
// a dead end: the only way to reach a sibling feature was to follow a
// single "back to workspace" link, land on chat, then click again.
// Rendered once from w/layout.tsx so every one of those pages gets the
// same lateral navigation instead of each re-implementing its own.
//
// The six items are grouped the same way the workspace's own data is
// organized -- "happening now", "things you build", "things you keep",
// and admin -- rather than left as one flat row.
const glyphs = {
  chat: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v11H8l-4 3V5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  ),
  activity: (
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
  ),
  agent: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="9" cy="13" r="1.4" fill="currentColor" />
      <circle cx="15" cy="13" r="1.4" fill="currentColor" />
      <path d="M12 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  grid: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  overview: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="4" width="6" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="11" width="6" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="14" width="7" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  tasks: (
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
  ),
  memory: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 4.5A2.5 2.5 0 0 0 3.5 7v10.5A2.5 2.5 0 0 1 6 15h4.5a2.5 2.5 0 0 1 2.5 2.5V7a2.5 2.5 0 0 0-2.5-2.5H6Zm12 0A2.5 2.5 0 0 1 20.5 7v10.5A2.5 2.5 0 0 0 18 15h-4.5a2.5 2.5 0 0 0-2.5 2.5V7a2.5 2.5 0 0 1 2.5-2.5H18Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  ),
  artifact: (
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
  ),
  plug: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M8 3v6m8-6v6M6 9h12v2a6 6 0 0 1-12 0V9Zm6 8v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  ),
  observe: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 18V6m5 12v-7m5 7V4m5 14v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 20h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  shield: (
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
  ),
  workflow: (
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
  ),
};

function groupsFor(workspaceId: string) {
  return [
    {
      label: "Workspace",
      items: [
        { href: `/w/${workspaceId}/overview`, label: "Overview", glyph: glyphs.overview, exact: false },
        { href: `/w/${workspaceId}`, label: "Chat", glyph: glyphs.chat, exact: true },
        { href: `/w/${workspaceId}/tasks`, label: "Tasks", glyph: glyphs.tasks, exact: false },
        { href: `/w/${workspaceId}/audit`, label: "Activity", glyph: glyphs.activity, exact: false },
      ],
    },
    {
      label: "Build",
      items: [
        { href: `/w/${workspaceId}/agents`, label: "Agents", glyph: glyphs.agent, exact: false },
        { href: `/w/${workspaceId}/workflows`, label: "Workflows", glyph: glyphs.workflow, exact: false },
        { href: `/w/${workspaceId}/approvals`, label: "Approvals", glyph: glyphs.shield, exact: false },
      ],
    },
    {
      label: "Keep",
      items: [
        { href: `/w/${workspaceId}/memory`, label: "Memory", glyph: glyphs.memory, exact: false },
        { href: `/w/${workspaceId}/artifacts`, label: "Artifacts", glyph: glyphs.artifact, exact: false },
        { href: `/w/${workspaceId}/integrations`, label: "Integrations", glyph: glyphs.plug, exact: false },
        { href: `/w/${workspaceId}/observability`, label: "Observability", glyph: glyphs.observe, exact: false },
        { href: `/w/${workspaceId}/notifications`, label: "Notifications", glyph: glyphs.bell, exact: false },
      ],
    },
  ];
}

export default function WorkspaceSecondaryNav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const groups = groupsFor(workspaceId);
  return (
    <nav className="workspace-secondary-nav" aria-label="Workspace sections">
      {groups.map((group, index) => (
        <div className="workspace-secondary-nav-group" key={group.label}>
          {index > 0 && <span className="workspace-secondary-nav-divider" aria-hidden="true" />}
          <span className="workspace-secondary-nav-label">{group.label}</span>
          {group.items.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "active" : ""}
                aria-current={active ? "page" : undefined}
              >
                {item.glyph} {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
