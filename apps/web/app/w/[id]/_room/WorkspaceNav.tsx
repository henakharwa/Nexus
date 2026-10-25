import Link from "next/link";
import {
  ActivityGlyph,
  ArtifactGlyph,
  BellGlyph,
  ChatGlyph,
  GridGlyph,
  MemoryGlyph,
  ObserveGlyph,
  PlugGlyph,
  ShieldGlyph,
  TasksGlyph,
  WorkflowGlyph,
  WorkspaceAgentGlyph,
} from "./glyphs";

// Links to the workspace's other pages, in sidebar order.
export default function WorkspaceNav({ workspaceId }: { workspaceId: string }) {
  const pages = [
    ["overview", "Overview", GridGlyph],
    ["audit", "Activity", ActivityGlyph],
    ["integrations", "Integrations", PlugGlyph],
    ["observability", "Observability", ObserveGlyph],
    ["notifications", "Notifications", BellGlyph],
    ["agents", "Agents", WorkspaceAgentGlyph],
    ["workflows", "Workflows", WorkflowGlyph],
    ["approvals", "Approvals", ShieldGlyph],
    ["tasks", "Tasks", TasksGlyph],
    ["memory", "Memory", MemoryGlyph],
    ["artifacts", "Artifacts", ArtifactGlyph],
  ] as const;
  return (
    <nav className="workspace-nav" aria-label="Workspace navigation">
      <a className="active" href="#conversation">
        <ChatGlyph /> Conversation
      </a>
      {pages.map(([path, label, Glyph]) => (
        <Link key={path} href={`/w/${workspaceId}/${path}`}>
          <Glyph /> {label}
        </Link>
      ))}
    </nav>
  );
}
