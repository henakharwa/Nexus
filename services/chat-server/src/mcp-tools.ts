import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutor } from "./tools.js";

// Converts one MCP server's listTools() result into this project's
// ToolExecutor shape, so the agent loop (agent.ts) and the
// confirm-before-write machinery (actions.ts's wrapForProposal) can treat
// an MCP-provided tool exactly like this project's own hand-written ones
// -- neither cares where a tool came from, only its `mutates` flag and
// whether it has describe()/preview().
//
// Never use an MCP server's `annotations.readOnlyHint` to decide whether a
// call can run without human approval. MCP explicitly describes annotations
// as hints from a potentially untrusted server, and a compromised or simply
// mistaken provider must not be able to turn a write into an unreviewed call.
//
// This is deliberately an allowlist, not a name heuristic. A tool is read
// only when Nexus recognizes the provider/tool pair below; everything else
// is treated as a write and therefore becomes an approval proposal.
// `provider` is the connected service's display name ("GitHub", "Slack",
// "Linear", ...). It appears on the approval card and in error messages, so
// a Slack post is never described as running "on GitHub".
const READ_ONLY_TOOLS: Record<string, ReadonlySet<string>> = {
  github: new Set([
    "get_me", "get_file_contents", "get_commit", "get_issue", "issue_read", "get_pull_request", "pull_request_read",
    "get_repository", "get_discussion", "get_branch", "get_tag", "get_release", "get_workflow", "get_workflow_run",
    "list_issues", "list_pull_requests", "list_branches", "list_commits", "list_tags", "list_releases", "list_workflows",
    "list_workflow_runs", "list_workflow_jobs", "list_code_scanning_alerts", "list_discussions", "list_issue_comments",
    "list_pull_request_comments", "list_pull_request_files", "list_pull_request_reviews", "list_collaborators", "list_labels",
    "list_milestones", "list_projects", "search_code", "search_issues", "search_repositories", "search_users",
  ]),
  slack: new Set([
    "slack_list_channels", "slack_search_channels", "slack_search_public_and_private_channels", "slack_get_channel_history",
    "slack_search_messages", "slack_get_thread_replies", "slack_list_users", "slack_get_user_profile",
  ]),
  linear: new Set([
    "get_issue", "get_project", "get_team", "get_user", "list_issues", "list_projects", "list_comments",
    "list_issue_statuses", "list_teams", "list_users", "search_issues", "search_projects", "search_users",
  ]),
  notion: new Set(["notion_search", "notion_get_page", "notion_get_page_content", "notion_query_database"]),
  figma: new Set(["get_file", "get_file_nodes", "get_file_images", "get_team_projects", "get_project_files"]),
};

/** True only for a Nexus-reviewed provider/tool pair that cannot change external state. */
export function isNexusReadOnlyTool(provider: string, name: string): boolean {
  return READ_ONLY_TOOLS[provider.trim().toLowerCase()]?.has(name) ?? false;
}

export function mcpToolToExecutor(client: Client, tool: McpTool, provider = "GitHub"): ToolExecutor {
  const mutates = !isNexusReadOnlyTool(provider, tool.name);
  return {
    definition: {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? tool.name,
        // Some GitHub MCP schemas use uppercase enum values (OPEN/CLOSED),
        // while models naturally emit lowercase. Accept either at the LLM
        // boundary and normalize immediately before the MCP call.
        parameters: compatibilitySchema(tool.inputSchema as Record<string, unknown>),
      },
    },
    mutates,
    // GitHub's MCP server doesn't ship this project's own hand-crafted
    // describe()/preview() text (that only exists for the old Octokit
    // tool specs) -- these generic fallbacks are what the confirmation
    // card shows instead: describe() as the one-line headline, preview()
    // as the fuller "here's exactly what you're about to run" detail.
    describe: mutates ? (args) => describeCall(tool, args, provider) : undefined,
    preview: mutates ? (args) => previewCall(tool, args) : undefined,
    execute: (args) => callMcpTool(client, tool.name, normalizeCompatibilityArgs(args, tool.inputSchema as Record<string, unknown>), provider),
  };
}

function compatibilitySchema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(schema) as Record<string, unknown>;
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.enum) && record.enum.every((item) => typeof item === "string")) {
      record.enum = [...new Set([...record.enum as string[], ...(record.enum as string[]).map((item) => item.toLowerCase())])];
    }
    Object.values(record).forEach(walk);
  };
  walk(copy);
  return copy;
}

// compatibilitySchema() lets the model send an enum value in either case.
// Map each such value back to the exact spelling the tool's own schema
// declares. GitHub's MCP tools are not consistent: list_issues expects
// OPEN/CLOSED while list_pull_requests expects open/closed/all, so blindly
// upper-casing `state` broke every pull-request listing.
export function normalizeCompatibilityArgs(args: Record<string, unknown>, schema?: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema?.properties ?? {}) as Record<string, { enum?: unknown[] } | undefined>;
  const copy = { ...args };
  for (const [key, value] of Object.entries(copy)) {
    const allowed = properties[key]?.enum;
    if (typeof value !== "string" || !Array.isArray(allowed) || allowed.includes(value)) continue;
    const match = allowed.find((item) => typeof item === "string" && item.toLowerCase() === value.toLowerCase());
    if (typeof match === "string") copy[key] = match;
  }
  return copy;
}

/** Fetches this MCP client's full tool list and converts every one of them. */
export async function listMcpToolExecutors(client: Client, provider = "GitHub"): Promise<ToolExecutor[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => mcpToolToExecutor(client, tool as McpTool, provider));
}

function describeCall(tool: McpTool, args: Record<string, unknown>, provider: string): string {
  const label = tool.name.replace(/_/g, " ");
  // Several of github-mcp-server's tools are "mega-tools" that dispatch on
  // a `method` argument (e.g. issue_write's method can be "create",
  // "update", ...) rather than being one tool per verb the way this
  // project's old Octokit specs were -- surfacing method (when present)
  // is what makes the confirmation card's headline actually specific
  // instead of just repeating the tool's name.
  const method = typeof args.method === "string" && args.method ? ` (${args.method})` : "";
  return `Run "${label}"${method} on ${provider}`;
}

function previewCall(tool: McpTool, args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const destructive = tool.annotations?.destructiveHint === true ? "⚠️ This cannot be undone.\n" : "";
  if (entries.length === 0) return `${destructive}${tool.name}: no arguments given.`;
  const lines = entries.map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    // Shown in full on the approval card (it scrolls). The cap only guards
    // against a runaway argument, and says what it left out.
    return `${key}: ${truncate(text, 20_000)}`;
  });
  return `${destructive}${lines.join("\n")}`;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}\n[… ${(text.length - maxLen).toLocaleString("en-US")} more characters not shown]`;
}

async function callMcpTool(client: Client, name: string, args: Record<string, unknown>, provider: string): Promise<unknown> {
  const result = await client.callTool({ name, arguments: normalizeGithubArguments(name, args) });
  const content = Array.isArray((result as { content?: unknown }).content)
    ? ((result as { content: { type: string; text?: string }[] }).content)
    : [];
  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  if ((result as { isError?: boolean }).isError) {
    const error = text || `${provider} MCP tool "${name}" reported an error`;
    // The model receives this error as its tool result, but it may reduce
    // it to a vague apology in the chat. Keep a bounded server-side record
    // so a failed connected-tool request can be diagnosed without logging
    // arguments (which may contain user or repository content).
    console.error(`[mcp] tool "${name}" failed: ${error.slice(0, 500)}`);
    throw new Error(error);
  }
  return text.length > 0 ? text : result;
}

// github-mcp-server's issue_write schema has ordinary top-level fields
// (title, body, labels, etc.) plus issue_fields for *custom* GitHub Issue
// fields. Smaller models occasionally treat the latter as a generic field
// bag and send `{ issue_fields: [{ field_name: "title", value: "…" }] }`.
// GitHub then tries to resolve a custom field literally called "title" and
// rejects the call. Normalize only those well-known standard fields while
// preserving genuine custom-field entries untouched.
const STANDARD_ISSUE_FIELDS = new Set(["title", "body", "labels", "assignees", "milestone", "state", "state_reason"]);

export function normalizeGithubArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  // Models often pass ref "HEAD" to mean "the default branch". GitHub's MCP
  // server cannot resolve that name; omitting ref reads the default branch.
  if (name === "get_file_contents" && typeof args.ref === "string" && /^(refs\/heads\/)?HEAD$/i.test(args.ref.trim())) {
    const { ref: _ref, ...rest } = args;
    return rest;
  }
  if (name !== "issue_write" || !args.issue_fields) return args;
  const normalized = { ...args };
  const customFields: unknown[] = [];
  const copyStandardField = (field: string, value: unknown) => {
    if (STANDARD_ISSUE_FIELDS.has(field) && normalized[field] === undefined && value !== undefined) normalized[field] = value;
    else customFields.push({ field_name: field, value });
  };

  if (Array.isArray(args.issue_fields)) {
    for (const entry of args.issue_fields) {
      if (!entry || typeof entry !== "object") { customFields.push(entry); continue; }
      const record = entry as Record<string, unknown>;
      const field = typeof record.field_name === "string" ? record.field_name : typeof record.name === "string" ? record.name : "";
      if (field) copyStandardField(field, record.value);
      else customFields.push(entry);
    }
  } else if (typeof args.issue_fields === "object") {
    for (const [field, value] of Object.entries(args.issue_fields as Record<string, unknown>)) copyStandardField(field, value);
  } else {
    return args;
  }

  if (customFields.length) normalized.issue_fields = customFields;
  else delete normalized.issue_fields;
  return normalized;
}
