// Line diffs for approval cards (change-preview.ts): what a file change will
// do, shown as changed lines with a little surrounding context, the way a
// pull request does. No dependency: a longest-common-subsequence diff over
// lines, after trimming the unchanged start and end, is plenty for the file
// sizes an agent edits. Files too large to diff fall back to a note.
import type { DiffLine } from "@mai-chat/shared-types";

const CONTEXT_LINES = 3;
// Beyond this many lines in the changed middle of a file (old x new), the
// LCS table gets too big to build on a chat server; show the new content.
const MAX_DIFF_CELLS = 4_000_000;

export interface LineDiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  // False when the files were too large to compare line by line.
  complete: boolean;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline doesn't make an extra empty line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Compares two versions of a file and returns the changed lines with context. */
export function diffLines(before: string, after: string): LineDiffResult {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_DIFF_CELLS) return { lines: [], added: midB.length, removed: midA.length, complete: false };

  // ops over the whole file: [type, oldIndex, newIndex]
  type Op = { type: "context" | "add" | "del"; oldIndex?: number; newIndex?: number };
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "context", oldIndex: i, newIndex: i });

  // LCS lengths for the changed middle, filled from the end.
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * cols + j] = midA[i] === midB[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      ops.push({ type: "context", oldIndex: start + i, newIndex: start + j });
      i++;
      j++;
    } else if (i < midA.length && (j === midB.length || table[(i + 1) * cols + j] >= table[i * cols + j + 1])) {
      // Removed lines come before the lines that replace them, as in git.
      ops.push({ type: "del", oldIndex: start + i });
      i++;
    } else {
      ops.push({ type: "add", newIndex: start + j });
      j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ type: "context", oldIndex: endA + k, newIndex: endB + k });

  // Keep changed lines plus CONTEXT_LINES around them; mark skipped runs.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type === "context") return;
    for (let k = Math.max(0, index - CONTEXT_LINES); k <= Math.min(ops.length - 1, index + CONTEXT_LINES); k++) keep[k] = true;
  });
  const lines: DiffLine[] = [];
  let skipped = 0;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      skipped++;
      return;
    }
    if (skipped) {
      lines.push({ type: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
    }
    const text = op.type === "add" ? b[op.newIndex!] : a[op.oldIndex!];
    lines.push({
      type: op.type,
      text,
      ...(op.oldIndex !== undefined ? { oldLine: op.oldIndex + 1 } : {}),
      ...(op.newIndex !== undefined ? { newLine: op.newIndex + 1 } : {}),
    });
  });
  if (skipped && lines.length) lines.push({ type: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return { lines, added: ops.filter((op) => op.type === "add").length, removed: ops.filter((op) => op.type === "del").length, complete: true };
}

/** Reads a unified diff patch (what GitHub returns for pull request files) into diff lines. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ type: "gap", text: raw });
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) lines.push({ type: "add", text: raw.slice(1), newLine: newLine++ });
    else if (raw.startsWith("-")) lines.push({ type: "del", text: raw.slice(1), oldLine: oldLine++ });
    else if (raw.startsWith(" ")) lines.push({ type: "context", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
  }
  return lines;
}

/** Keeps at most `max` lines, saying how many were left out. */
export function capLines(lines: DiffLine[], max: number): { lines: DiffLine[]; omitted: number } {
  if (lines.length <= max) return { lines, omitted: 0 };
  return { lines: lines.slice(0, max), omitted: lines.length - max };
}
