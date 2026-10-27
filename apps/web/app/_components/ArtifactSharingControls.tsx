"use client";

import type { WorkspaceArtifact } from "@mai-chat/shared-types";

type Props = {
  artifact: WorkspaceArtifact;
  publicUrl: string;
  slackChannel: string;
  shareExpiryHours: 24 | 168 | 720 | null;
  saving: boolean;
  onSlackChannelChange: (value: string) => void;
  onShareExpiryHoursChange: (value: 24 | 168 | 720 | null) => void;
  onCreatePublicLink: () => void;
  onCopyPublicLink: () => void;
  onRevokePublicLink: () => void;
  onShareToSlack: () => void;
};

export function ArtifactSharingControls({
  artifact,
  publicUrl,
  slackChannel,
  shareExpiryHours,
  saving,
  onSlackChannelChange,
  onShareExpiryHoursChange,
  onCreatePublicLink,
  onCopyPublicLink,
  onRevokePublicLink,
  onShareToSlack,
}: Props) {
  if (artifact.status !== "published") return null;
  return (
    <section className="artifact-sharing">
      <h3>Share published artifact</h3>
      {artifact.shareToken ? (
        <div>
          <input readOnly value={publicUrl} aria-label="Public artifact link" />
          <button type="button" className="secondary-button" onClick={onCopyPublicLink}>
            Copy link
          </button>
          <button type="button" className="secondary-button" disabled={saving} onClick={onRevokePublicLink}>
            Revoke link
          </button>
          <p className="muted">
            {artifact.shareExpiresAt
              ? `Expires ${new Date(artifact.shareExpiresAt).toLocaleString()} · ${artifact.shareViewCount} view${artifact.shareViewCount === 1 ? "" : "s"}`
              : `Never expires · ${artifact.shareViewCount} view${artifact.shareViewCount === 1 ? "" : "s"}`}
          </p>
        </div>
      ) : (
        <div>
          <label>
            Link expiry
            <select
              aria-label="Public link expiry"
              value={shareExpiryHours ?? "never"}
              onChange={(event) =>
                onShareExpiryHoursChange(
                  event.target.value === "never" ? null : (Number(event.target.value) as 24 | 168 | 720),
                )
              }
            >
              <option value="never">Never</option>
              <option value={24}>1 day</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </select>
          </label>
          <button type="button" className="secondary-button" disabled={saving} onClick={onCreatePublicLink}>
            Create public link
          </button>
        </div>
      )}
      <div>
        <input
          value={slackChannel}
          onChange={(event) => onSlackChannelChange(event.target.value)}
          placeholder="Slack channel, e.g. team-updates"
          aria-label="Slack channel"
        />
        <button type="button" className="secondary-button" disabled={saving} onClick={onShareToSlack}>
          Share to Slack
        </button>
      </div>
    </section>
  );
}
