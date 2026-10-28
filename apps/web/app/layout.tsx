import type { Metadata } from "next";
import { connection } from "next/server";
// Global styles, in cascade order: design tokens and base rules first, then
// the feature stylesheets in app/styles (numbered to keep their order).
import "./globals.css";
import "./styles/01-workspace-marketing.css";
import "./styles/02-workspace-permission.css";
import "./styles/03-workspace-integration.css";
import "./styles/04-integration-remote.css";
import "./styles/05-agent-workspace.css";
import "./styles/06-workflow-memory.css";
import "./styles/07-artifact-dashboard.css";
import "./styles/08-report-plan.css";
import "./styles/09-agent-task.css";
import "./styles/10-activity-audit.css";
import "./styles/11-notification-run.css";
import "./styles/12-access-app.css";
import "./styles/13-approval-rules.css";
import { DialogProvider } from "./_components/DialogProvider";

export const metadata: Metadata = {
  title: "Nexus",
  description: "A shared AI workspace for teams, connected tools, and human-approved actions.",
  icons: {
    icon: "/nexus-landing-logo.png",
    shortcut: "/nexus-landing-logo.png",
    apple: "/nexus-landing-logo.png",
  },
};

// Every page renders per request so Next.js can stamp the CSP nonce from
// proxy.ts on its scripts (a prerendered page has no nonce and would be
// blocked by the policy).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <DialogProvider>{children}</DialogProvider>
      </body>
    </html>
  );
}
