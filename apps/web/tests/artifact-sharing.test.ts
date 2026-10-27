import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceArtifact } from "@mai-chat/shared-types";
import { normalizeSlackChannel, publicArtifactPath } from "../lib/artifact-sharing";
import { ArtifactSharingControls } from "../app/_components/ArtifactSharingControls";
import { ArtifactBuilderChrome } from "../app/_components/ArtifactBuilderChrome";
import type { WorkspaceArtifactInput } from "../lib/api";

const artifact = (status: WorkspaceArtifact["status"], shareToken: string | null): WorkspaceArtifact => ({
  id: "artifact-1",
  workspaceId: "workspace-1",
  type: "plan",
  status,
  title: "Launch plan",
  summary: "",
  content: "",
  dashboardData: null,
  shareToken,
  shareExpiresAt: null,
  shareViewCount: 0,
  releaseVersion: null,
  ownerUserId: null,
  ownerName: null,
  createdByUserId: null,
  createdByName: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const sharingProps = (value: WorkspaceArtifact) => ({
  artifact: value,
  publicUrl: "https://nexus.example/shared/token",
  slackChannel: "team-updates",
  shareExpiryHours: 168 as const,
  saving: false,
  onSlackChannelChange: () => {},
  onShareExpiryHoursChange: () => {},
  onCreatePublicLink: () => {},
  onCopyPublicLink: () => {},
  onRevokePublicLink: () => {},
  onShareToSlack: () => {},
});

describe("artifact sharing helpers", () => {
  it("uses the correct public route for each artifact type", () => {
    expect(publicArtifactPath("dashboard", "token")).toBe("/dashboard/token");
    expect(publicArtifactPath("release_notes", "token")).toBe("/release-notes/token");
    expect(publicArtifactPath("plan", "token")).toBe("/shared/token");
    expect(publicArtifactPath("report", "token")).toBe("/shared/token");
    expect(publicArtifactPath("task_list", "token")).toBe("/shared/token");
  });

  it("normalizes Slack channel entries without changing channel names", () => {
    expect(normalizeSlackChannel(" #team-updates ")).toBe("team-updates");
    expect(normalizeSlackChannel("engineering_platform")).toBe("engineering_platform");
    expect(normalizeSlackChannel("   ")).toBe("");
  });

  it("renders sharing controls only for published artifacts", () => {
    const published = renderToStaticMarkup(
      createElement(ArtifactSharingControls, sharingProps(artifact("published", "token"))),
    );
    expect(published).toContain("Copy link");
    expect(published).toContain("Revoke link");
    expect(published).toContain("Share to Slack");
    expect(renderToStaticMarkup(createElement(ArtifactSharingControls, sharingProps(artifact("draft", null))))).toBe(
      "",
    );
  });

  it("renders all builder stages and review content", () => {
    const draft: WorkspaceArtifactInput = {
      type: "plan",
      status: "draft",
      title: "Release readiness",
      summary: "Review milestones",
      content: "## Next step\nShip",
      ownerUserId: null,
    };
    const markup = renderToStaticMarkup(
      createElement(ArtifactBuilderChrome, {
        title: "New artifact",
        draft,
        members: [],
        step: "review",
        onStepChange: () => {},
      }),
    );
    expect(markup).toContain("Setup");
    expect(markup).toContain("Compose");
    expect(markup).toContain("Review");
    expect(markup).toContain("Release readiness");
    expect(markup).toContain("characters of content ready");
    expect(markup).toContain('aria-current="step"');
  });
});
