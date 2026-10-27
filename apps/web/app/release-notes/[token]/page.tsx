"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { PublicReleaseNotesView } from "@mai-chat/shared-types";
import { describeError, getPublicReleaseNotes } from "../../../lib/api";

// Public, unauthenticated view for a Release Notes artifact's share link
// (see artifacts/page.tsx's "Create public link" and server.ts's GET
// /public/release-notes/:token). Outside app/w/ for the same reason as
// app/dashboard/[token]/page.tsx -- no session required to read this.
export default function PublicReleaseNotesPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<PublicReleaseNotesView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getPublicReleaseNotes(token)
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err, "Could not load these release notes."));
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

  return (
    <main className="public-dashboard-page">
      <header>
        <p className="eyebrow">RELEASE NOTES{view.releaseVersion ? ` · ${view.releaseVersion}` : ""}</p>
        <h1>{view.title}</h1>
        {view.summary && <p>{view.summary}</p>}
      </header>
      <article className="public-release-notes-body">{view.content}</article>
      <p className="public-dashboard-footnote">
        Published {new Date(view.updatedAt).toLocaleString()} · Read-only view shared from Nexus.
      </p>
    </main>
  );
}
