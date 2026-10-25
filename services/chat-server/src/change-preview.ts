// What an agent-proposed action will change, built when it's proposed and
// shown on the approval card, so approving isn't a judgement on a one-line
// description:
//   - a GitHub file change: a line diff of the current file against the
//     proposed content;
//   - a pull request or merge: the title, branches and each changed file's
//     diff;
//   - an issue update: each field from -> to;
//   - a comment, issue or Slack message: its full text;
//   - anything else: every argument, in full.
// Nothing is silently cut: very long text is capped with a visible note
// saying how much is left out. Every GitHub lookup is best effort; when one
// fails, the section says so and shows what's known.
import type { ActionTarget, ChangePreview, ChangePreviewSection } from "@mai-chat/shared-types";
import type { GithubLookups } from "./actions.js";
import { capLines, diffLines, parsePatch } from "./line-diff.js";

const MAX_TEXT = 20_000;
const MAX_DIFF_LINES = 600;
const MAX_FILE_DIFF_LINES = 300;
const MAX_FILES = 20;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null);

/** Full text, or the first MAX_TEXT characters with a visible note about the rest. */
export function fullText(value: string): string {
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}\n\n[… ${(value.length - MAX_TEXT).toLocaleString("en-US")} more characters not shown]`;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return fullText(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(", ");
  return fullText(JSON.stringify(value, null, 2));
}

/** Every argument in full, for tools without a more specific preview. */
function argumentFields(args: Record<string, unknown>, skip: string[] = []): ChangePreviewSection | null {
  const fields = Object.entries(args)
    .filter(([key, value]) => !skip.includes(key) && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({ label: key.replace(/_/g, " "), to: show(value) }));
  return fields.length ? { title: "Details", kind: "fields", fields } : null;
}

function fileSections(files: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string | null }>): ChangePreviewSection[] {
  const sections: ChangePreviewSection[] = files.slice(0, MAX_FILES).map((file) => {
    const title = `${file.filename} (${file.status}, +${file.additions} −${file.deletions})`;
    if (!file.patch) return { title, kind: "text", text: "", note: "GitHub doesn't show a diff for this file (binary or very large)." };
    const capped = capLines(parsePatch(file.patch), MAX_FILE_DIFF_LINES);
    return { title, kind: "diff", lines: capped.lines, ...(capped.omitted ? { note: `Showing the first ${MAX_FILE_DIFF_LINES} lines; ${capped.omitted} more on GitHub.` } : {}) };
  });
  if (files.length > MAX_FILES) sections.push({ title: `${files.length - MAX_FILES} more files`, kind: "text", text: "", note: "Open the pull request on GitHub to see every file." });
  return sections;
}

async function githubPreview(toolName: string, args: Record<string, unknown>, target: ActionTarget, lookups?: GithubLookups): Promise<ChangePreviewSection[]> {
  const owner = text(args.owner);
  const repo = text(args.repo);
  const where = owner && repo ? { owner, repo } : null;
  const number = num(args.issue_number) ?? num(args.issueNumber) ?? num(args.pullNumber) ?? num(args.pull_number);
  const method = text(args.method)?.toLowerCase() ?? null;

  // A file change: diff the current file against the proposed content.
  const path = text(args.path);
  const content = typeof args.content === "string" ? args.content : null;
  if (path && content !== null && target.kind === "file") {
    const branch = text(args.branch) ?? target.baseBranch ?? null;
    const sections: ChangePreviewSection[] = [];
    const current = where && lookups?.fileText ? await lookups.fileText(where.owner, where.repo, path, branch).catch(() => null) : null;
    const title = `${path}${branch ? ` on ${branch}` : ""}`;
    if (current === null) {
      sections.push({ title, kind: "text", text: fullText(content), note: "Couldn't read the current file from GitHub, so this is the complete new content rather than a diff." });
    } else {
      const diff = diffLines(current.exists ? current.text : "", content);
      if (!diff.complete) sections.push({ title, kind: "text", text: fullText(content), note: "Too large to compare line by line; this is the complete new content." });
      else {
        const capped = capLines(diff.lines, MAX_DIFF_LINES);
        const notes = [current.exists ? null : "New file.", diff.added + diff.removed === 0 ? "No change: the new content is the same as the current file." : null, capped.omitted ? `Showing the first ${MAX_DIFF_LINES} lines of the diff; ${capped.omitted} more not shown.` : null].filter(Boolean);
        sections.push({ title: `${title} (+${diff.added} −${diff.removed})`, kind: "diff", lines: capped.lines, ...(notes.length ? { note: notes.join(" ") } : {}) });
      }
    }
    if (text(args.message)) sections.push({ title: "Commit message", kind: "text", text: fullText(String(args.message)) });
    return sections;
  }

  // A new pull request: what it says, and what it would merge.
  if (toolName === "create_pull_request") {
    const head = text(args.head);
    const base = text(args.base) ?? target.baseBranch ?? null;
    const sections: ChangePreviewSection[] = [
      { title: "Pull request", kind: "fields", fields: [{ label: "Title", to: show(args.title) }, { label: "Merges", to: `${head ?? "?"} into ${base ?? "the default branch"}` }, ...(text(args.body) ? [{ label: "Description", to: show(args.body) }] : []), ...(args.draft === true ? [{ label: "Draft", to: "yes" }] : [])] },
    ];
    if (where && head && base && lookups?.changedFiles) {
      const files = await lookups.changedFiles(where.owner, where.repo, { base, head }).catch(() => null);
      if (files) sections.push(...fileSections(files));
      else sections.push({ title: "Files", kind: "text", text: "", note: "Couldn't read the changed files from GitHub." });
    }
    return sections;
  }

  // A merge: which pull request, between which branches, and its files.
  if (target.kind === "merge" && number && where) {
    const pull = lookups?.pullRequest ? await lookups.pullRequest(where.owner, where.repo, number).catch(() => null) : null;
    const sections: ChangePreviewSection[] = [
      {
        title: `Merge pull request #${number}`,
        kind: "fields",
        fields: [
          ...(pull ? [{ label: "Title", to: pull.title }, { label: "Merges", to: `${pull.head} into ${pull.base}` }] : []),
          ...(text(args.merge_method) ? [{ label: "Merge method", to: String(args.merge_method) }] : []),
          ...(text(args.commit_title) ? [{ label: "Commit title", to: show(args.commit_title) }] : []),
          ...(text(args.commit_message) ? [{ label: "Commit message", to: show(args.commit_message) }] : []),
        ],
        ...(pull ? {} : { note: "Couldn't read this pull request from GitHub." }),
      },
    ];
    const files = lookups?.changedFiles ? await lookups.changedFiles(where.owner, where.repo, { pullNumber: number }).catch(() => null) : null;
    if (files) sections.push(...fileSections(files));
    return sections;
  }

  // A comment: its full text.
  if (toolName === "add_issue_comment" || target.kind === "comment") {
    return [{ title: `Comment${number ? ` on #${number}` : ""}`, kind: "text", text: fullText(text(args.body) ?? text(args.comment) ?? "") }];
  }

  // An issue update: each changed field from -> to.
  if (number && (toolName === "issue_write" || toolName === "update_issue") && method !== "create") {
    const current = where && lookups?.issue ? await lookups.issue(where.owner, where.repo, number).catch(() => null) : null;
    const fields: Array<{ label: string; from?: string | null; to: string }> = [];
    const compare = (label: string, key: string, before: string | undefined) => {
      if (args[key] === undefined || args[key] === null) return;
      fields.push({ label, ...(current ? { from: before ?? "" } : {}), to: show(args[key]) });
    };
    compare("Title", "title", current?.title);
    compare("Description", "body", current?.body);
    compare("State", "state", current?.state);
    compare("Labels", "labels", current?.labels.join(", "));
    compare("Assignees", "assignees", undefined);
    const rest = argumentFields(args, ["owner", "repo", "method", "issue_number", "issueNumber", "title", "body", "state", "labels", "assignees"]);
    return [{ title: `Changes to issue #${number}`, kind: "fields", fields, ...(current ? {} : { note: "Couldn't read the current issue from GitHub, so only the new values are shown." }) }, ...(rest ? [rest] : [])];
  }

  // A new issue, a branch, or anything else: every argument in full.
  const details = argumentFields(args, ["owner", "repo"]);
  return details ? [{ ...details, title: target.kind === "new_issue" ? "New issue" : details.title }] : [];
}

/**
 * Builds the preview for an action, or null when there's nothing more to
 * show than the card's headline. Never throws: a preview is a convenience,
 * and failing to build one must not stop the proposal.
 */
export async function buildChangePreview(toolName: string, args: Record<string, unknown>, target: ActionTarget, lookups?: GithubLookups): Promise<ChangePreview | null> {
  try {
    let sections: ChangePreviewSection[];
    if (target.provider === "github") sections = await githubPreview(toolName, args, target, lookups);
    else if (target.provider === "slack" && (text(args.message) ?? text(args.text) ?? text(args.markdown_text))) {
      const channel = target.channelName ?? target.channel ?? "the channel";
      sections = [
        { title: `Message to #${String(channel).replace(/^#/, "")}`, kind: "text", text: fullText(text(args.message) ?? text(args.text) ?? text(args.markdown_text) ?? "") },
        ...(text(args.thread_ts) ? [{ title: "Posted as a reply in a thread", kind: "text" as const, text: "" }] : []),
      ];
    } else {
      const details = argumentFields(args);
      sections = details ? [details] : [];
    }
    return sections.length ? { sections } : null;
  } catch {
    const details = argumentFields(args);
    return details ? { sections: [details] } : null;
  }
}
