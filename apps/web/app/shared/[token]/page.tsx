"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { PublicArtifactView } from "@mai-chat/shared-types";
import { describeError, getPublicArtifact } from "../../../lib/api";

// Public, unauthenticated view for a Plan / Report / Task list artifact's
// share link (see artifacts/page.tsx's "Create public link" and server.ts's
// GET /public/artifacts/:token). Dashboard and Release notes each render
// differently enough to keep their own pages (app/dashboard/[token],
// app/release-notes/[token]); these three types share plain title/summary/
// content, so one generic page covers all of them.
const typeLabel: Record<PublicArtifactView["type"], string> = {
  plan: "PLAN",
  report: "REPORT",
  task_list: "TASK LIST",
  release_notes: "RELEASE NOTES",
  dashboard: "DASHBOARD",
};

function checklistProgress(content: string): { done: number; total: number } | null {
  const items = content.match(/^- \[[ xX]\]/gm);
  if (!items || !items.length) return null;
  const done = items.filter((item) => /\[[xX]\]/.test(item)).length;
  return { done, total: items.length };
}

export default function PublicArtifactPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<PublicArtifactView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getPublicArtifact(token)
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err, "Could not load this artifact."));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error)
    return (
      <main className="public-dashboard-page">
        <p className="error-text">{error}</p>
      </main>
    );
  if (!view)
    return (
      <main className="public-dashboard-page">
        <p className="muted">Loading…</p>
      </main>
    );

  const progress = view.type === "plan" || view.type === "task_list" ? checklistProgress(view.content) : null;

  return (
    <main className="public-dashboard-page">
      <header>
        <p className="eyebrow">{typeLabel[view.type]}</p>
        <h1>{view.title}</h1>
        {view.summary && <p>{view.summary}</p>}
        {progress && progress.total > 0 && (
          <div className="readiness-track" style={{ marginTop: 12 }}>
            <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
        {progress && progress.total > 0 && (
          <small className="muted">
            {progress.done}/{progress.total} complete
          </small>
        )}
      </header>
      <article className="public-release-notes-body">{view.content}</article>
      <p className="public-dashboard-footnote">
        Published {new Date(view.updatedAt).toLocaleString()} · Read-only view shared from Nexus.
      </p>
    </main>
  );
}
