"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { PublicDashboardView } from "@mai-chat/shared-types";
import { describeError, getPublicDashboard } from "../../../lib/api";
import { DashboardCanvas } from "../../_components/DashboardCanvas";

// Public, unauthenticated view for a dashboard's share link (see
// artifacts/page.tsx's "Create public link" and server.ts's GET
// /public/dashboards/:token). Deliberately outside app/w/ -- that
// segment's layout (WorkspaceAuth) requires a session, and anyone with
// this link, workspace member or not, should be able to open it.
export default function PublicDashboardPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<PublicDashboardView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getPublicDashboard(token)
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err, "Could not load this dashboard."));
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
        <p className="eyebrow">SHARED DASHBOARD</p>
        <h1>{view.title}</h1>
        {view.summary && <p>{view.summary}</p>}
      </header>
      <DashboardCanvas value={view.dashboardData} versions={[]} updatedAt={view.updatedAt} />
      <p className="public-dashboard-footnote">
        Read-only view shared from Nexus. Numbers refresh whenever a workspace member hits "Refresh live data".
      </p>
    </main>
  );
}
