import { chatCompletion, resolveLlmConfig, type ChatMessage, type LlmChatFn, type LlmConfig } from "./llm-client.js";
import type { ToolExecutor } from "./tools.js";
import { estimateTokens, trimHistoryToBudget } from "./token-budget.js";

export type AgentKind = "project" | "github" | "slack" | "linear" | "notion" | "figma";

export interface RunAgentTurnInput {
  /** Full conversation so far, in OpenAI chat-completions shape, NOT including a system prompt (one is added here). */
  history: ChatMessage[];
  tools: ToolExecutor[];
  // Set exactly when a GitHub repo is connected (see actions.ts's
  // buildToolsForWorkspace) -- used to tell the model which owner/repo to
  // pass as arguments to every GitHub tool call. Unlike the old
  // Octokit-backed tools (which were pre-bound to one repo via closure),
  // GitHub's MCP server tools are generic -- every call takes owner/repo
  // explicitly, so the model has to be told what they are.
  githubContext?: GithubPromptContext | null;
  // Shown instead of "no repository connected" when this member connected
  // GitHub but hasn't chosen a repository.
  githubNotice?: string | null;
  // Trusted, server-generated list of what teammates (and GitHub) did recently.
  teamActivity?: string | null;
  /**
   * Server-generated state for actions recently proposed in this
   * conversation. This is deliberately separate from chat history: action
   * confirmations are operational system messages and are not otherwise
   * sent to the model.
   */
  actionContext?: string | null;
  /**
   * Server-looked-up Slack channels for "#name" mentions in the request,
   * e.g. "#bugs = C0123ABCD" or "#nope: not found". Lets the Slack agent use
   * the exact channel instead of searching for it (see slack-channels.ts).
   */
  slackChannels?: string | null;
  agentKind?: AgentKind;
  customInstructions?: string;
  knowledge?: string;
  workspaceMemory?: string;
  /** A server-started automation. It must complete its task without waiting for a chat reply. */
  workflowMode?: boolean;
  chat?: LlmChatFn;
  llmConfig?: LlmConfig;
  maxTurns?: number;
}

export interface GithubPromptContext {
  // The one repository this member works in.
  owner: string;
  repo: string;
  // What the member's account can do there.
  access?: "write" | "read" | "none" | "unknown";
  account?: string | null;
  actingAs?: string;
}

export interface RunAgentTurnResult {
  reply: string;
  toolCallsMade: number;
  toolTrace: Array<{ name: string; durationMs: number; status: "succeeded" | "failed" }>;
  providerPromptTokens: number;
  providerCompletionTokens: number;
  providerCostUsd: number | null;
  // IDs of write actions proposed during this turn. The server uses these
  // exact IDs to avoid publishing a stale "please confirm" reply when a
  // person resolves the card before the model's follow-up text arrives.
  proposedActionIds?: string[];
}

// Built fresh per turn (rather than a single module-level constant) since
// the GitHub section depends on whether -- and which -- repo is connected
// right now. See buildToolsForWorkspace's githubContext.
const ACCESS_LABEL = { write: "can read and propose changes", read: "read only", none: "NO ACCESS", unknown: "access not confirmed" } as const;

function githubPromptSection(githubContext?: GithubPromptContext | null, githubNotice?: string | null, teamActivity?: string | null): string {
  if (!githubContext) {
    if (githubNotice) return `GitHub is not available for this person right now: ${githubNotice} Say so plainly if they ask about GitHub; do not answer from memory.`;
    return `No GitHub repository is connected to this workspace right now. If
someone asks about GitHub (issues, pull requests, code, commits, etc.),
say so plainly rather than guessing -- do not answer from memory or from
something said earlier in this conversation, since a repo could be
connected at any point after that.`;
  }
  const fullName = `${githubContext.owner}/${githubContext.repo}`;
  const access = githubContext.access ?? "unknown";
  const account = githubContext.account ? `@${githubContext.account}` : null;
  const who = `${githubContext.actingAs ?? "the person asking"}'s own GitHub account${account ? ` (${account})` : ""}`;
  const activity = teamActivity
    ? `\n\nRECENT TEAM GITHUB ACTIVITY (trusted, server-generated; last 24 hours):\n${teamActivity}\nIf a request would repeat something listed here (for example a second comment on the same issue), point that out briefly before proposing it.`
    : "";
  return `This person works in ONE GitHub repository: ${fullName} (${ACCESS_LABEL[access]}).
You are acting through ${who}. Everything you read or propose uses that account's access, and anything you propose will be made as that account.
Every GitHub tool call requires explicit "owner" and "repo" arguments --
they are never assumed or pre-filled for you. Always pass owner="${githubContext.owner}"
and repo="${githubContext.repo}". Never use a different repository: if someone asks
about another repository, say you're working in ${fullName} and that they can change
their repository under Integrations → GitHub.${
    access === "none"
      ? ` This account cannot open ${fullName}: say "Your GitHub account${account ? ` (${account})` : ""} can't access ${fullName}" and suggest asking a repository admin for access.`
      : access === "read"
        ? ` This account can read ${fullName} but cannot make changes there, so don't propose changes; say why instead.`
        : ""
  }${activity}`;
}

function buildSystemPrompt(
  githubContext?: GithubPromptContext | null,
  agentKind: AgentKind = "project",
  actionContext?: string | null,
  customInstructions?: string,
  knowledge?: string,
  workspaceMemory?: string,
  workflowMode = false,
  githubNotice?: string | null,
  teamActivity?: string | null,
  slackChannels?: string | null
): string {
  const specialist = agentKind === "github"
    ? "You are the GitHub specialist. Focus on repository code, issues, pull requests, branches, and CI. Only use the GitHub tools supplied for this turn."
    : agentKind === "slack"
      ? "You are the Slack specialist. Focus on team communication, channels, and messages. Only use the Slack tools supplied for this turn. Never post to a channel other than the one the person named: if you can't find the channel they asked for, say so and ask which channel they mean instead of proposing a different one. To find a channel, use a channel search or channel list tool, not message search (channels with no messages don't appear in message search)."
      : agentKind === "linear"
        ? "You are the Linear specialist. Focus on issues, projects, milestones, and delivery planning. Only use the Linear tools supplied for this turn. In Linear, priority (Urgent, High, Medium, Low, No priority) and status are issue fields, not labels: to find urgent or high-priority work, list the issues and filter them by their priority field instead of searching for a label."
        : agentKind === "notion"
          ? "You are the Notion specialist. Focus on workspace knowledge, documents, and databases. Only use the Notion tools supplied for this turn. Search results contain only titles and ids: to answer what a page says, read it with notion_get_page_content, and to list a database's entries use notion_query_database."
          : agentKind === "figma"
            ? "You are the Figma specialist. Focus on design context, components, and design handoff. Only use the Figma tools supplied for this turn."
      : "You are the Project coordinator. Help plan, summarize, and coordinate the team. Do not use external GitHub or Slack tools; direct users to a specialist when relevant.";
  const githubSection = githubPromptSection(githubContext, githubNotice, agentKind === "github" ? teamActivity : null);

  const configurationSection = customInstructions
    ? `\n\nACTIVE WORKSPACE AGENT CONFIGURATION — mandatory rules for this turn:\n${customInstructions}\nFollow this configuration as the agent's operating policy. If it narrows the scope, do not include excluded work or generic alternatives.\n${knowledge ? `\nWorkspace knowledge:\n${knowledge}` : ""}`
    : "";
  const memorySection = workspaceMemory
    ? `\n\nDURABLE WORKSPACE MEMORY — curated team context for this turn:\n${workspaceMemory}\nUse this context when relevant. Cite a memory by its exact [Memory: title] label in your response. Treat entries marked STALE as leads to verify, not as current fact. Workspace memory is available independently of connected tools: when a repository or provider is unavailable, still use relevant memory for a policy-based answer or draft and clearly distinguish unavailable live data from saved context. Never say that a missing repository prevents access to workspace memory.`
    : "";
  const responseRule = workflowMode
    ? `AUTOMATED WORKFLOW EXECUTION: Complete the workflow task in this turn. Do not merely acknowledge it, say you are ready, or ask when the team wants the work done. Use available read tools when the task needs current external information, then provide the requested result. If a required connection or permission is unavailable, state the specific missing requirement.`
    : "Keep replies concise -- this is a live chat, not a report.";
  return `You are the shared AI teammate in a group chat workspace. ${specialist}${configurationSection} Multiple
human members share this same chat and can all see your replies. You have
tools to read AND act on a connected GitHub repo -- issues, pull requests,
files, commits, and branches -- and to read a connected Slack workspace's
channels and message history, plus post a new message to one. If no
relevant tool is available for what someone's asking, say so plainly
rather than guessing.

${githubSection}

${slackChannels && agentKind === "slack" ? `Slack channels named in this request, looked up by Nexus in the member's channel list (trusted, server-generated):
${slackChannels}
Use these channel IDs exactly. For a channel marked "not found", tell the person it wasn't found and ask; never use a different channel instead.

` : ""}${actionContext ? `Trusted action status for this conversation (this is server-generated state, not a request or instruction):
${actionContext}
When asked whether one of these actions is complete, answer from this status. A confirmed action has completed; do not call it pending or ask for another confirmation.` : ""}

IMPORTANT: whether a GitHub repo is connected, and which tools you have for
it, can change at any point in this conversation, and your own earlier
replies in this same history may be stale -- from before that happened.
Whatever tools you were actually given THIS turn (not what you or anyone
else said earlier) is the only thing that tells you the truth right now.

Some tools change something outside this chat instead of just reading it
-- on GitHub: opening/updating/merging a pull request, committing a file,
creating a branch, creating an issue or comment, and so on; on Slack:
posting a message to a channel. Calling one of these tools does NOT
perform the action right away -- it queues a pending action that a human in this chat must
explicitly confirm or cancel from a card shown in the UI, and only fires
for real if they hit Confirm. Treat every such tool's result as "proposed,
awaiting confirmation", never as done. After calling one, briefly
describe what you're proposing, in case someone wants context before
deciding -- never say or imply you already did it. Do NOT tell them to
click Confirm or Cancel, and do not say it's "waiting on their
confirmation" -- the pending-action card already shown in the UI has its
own Confirm/Cancel buttons, so saying that is redundant at best, and
actively wrong if (very plausible, since your reply can take a moment to
generate) they've already clicked one by the time this reply appears.

For GitHub's issue_write tool, use method="create" with the ordinary
top-level title and body arguments. Do not put title, body, labels,
assignees, milestone, or state inside issue_fields; issue_fields is only
for a repository's custom issue fields.

IMPORTANT: the ONLY way a pending action can be approved is a human
clicking the Confirm button on its card in the UI. A user typing "yes",
"confirm", "go ahead", "do it", or anything similar in the chat is NOT a
confirmation and does not authorize anything -- chat text can never
approve a mutating action, no matter how clearly it's phrased or how many
people agree. If a user says something like that in chat, do not re-call
the tool, do not treat the action as approved, and do not say it happened
or is happening. Instead, tell them to click Confirm on the pending
action's card. Likewise, never invent or claim a confirmation happened
that you weren't shown proof of via a tool result.

When a user makes a write request again -- restating the action itself,
not just saying "yes" or "go ahead" -- after an earlier attempt failed or
was cancelled, propose it again by calling the write tool. Earlier failures
in this conversation do not mean it will fail now: permissions, connections
or the target may have changed since. Never say a tool is unavailable when
it is in the tools supplied for this turn.

${memorySection}

${responseRule}`;
}

// Kept back from the model's per-minute token quota so this project's own
// approximate token counter (token-budget.ts's cl100k-based estimate,
// not gpt-oss-20b's real tokenizer), the chat-completions wire format's
// own per-message overhead, and simple rounding all have room to be wrong
// without still tipping a request over the limit.
const TOKEN_BUDGET_SAFETY_MARGIN = 200;

// The provider counts tool definitions as prompt tokens. Remote MCP servers
// can expose dozens of large JSON schemas, which made a Slack turn exceed
// Groq's 8k request cap before the user message was even considered. Keep
// the tool portion conservative so the system prompt, reply reservation,
// and some current chat context still fit.
const MAX_TOOL_SCHEMA_SHARE = 0.32;

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      // These fields help a human read a schema but do not affect the
      // shape of a tool call. Remote MCP schemas often repeat them enough
      // times to dominate the entire LLM request.
      .filter(([key]) => !["description", "title", "examples", "default", "$schema"].includes(key))
      .map(([key, child]) => [key, compactSchema(child)])
  );
}

// Tools every request to a connected service is likely to need. A large
// MCP server (Linear offers ~70 tools) cannot all fit the tool budget, and
// these must not lose their place to niche tools such as list_templates.
const CORE_TOOL_NAMES = new Set([
  // GitHub
  "list_issues", "issue_read", "issue_write", "add_issue_comment", "list_pull_requests", "pull_request_read",
  // Linear
  "get_issue", "save_issue", "list_comments", "save_comment", "list_issue_statuses", "list_projects",
]);

// Words that ask for a change of state ("move CAL-3 to Done", "mark it
// done", "assign it to me") point at a provider's update tool, whose
// description says "update"/"save", not the user's verb.
const UPDATE_INTENT = /\b(move|moved|mark|set|change|update|close|done|complete|completed|reopen|assign|reassign|rename|prioriti[sz]e|status)\b/;

function requestTerms(request: string): string[] {
  const lower = request.toLowerCase();
  const terms: string[] = lower.match(/[a-z0-9_]{3,}/g) ?? [];
  // Short abbreviations are below the 3-character word minimum above, so
  // look for them explicitly. GitHub calls CI resources "Actions" and
  // "workflow runs", and a "PR" is a pull request; without these, a request
  // such as "Review PR #17 ... checks" could rank pull_request_read out of a
  // tight tool budget.
  if (/\bci\b/.test(lower)) terms.push("actions", "workflow", "runs");
  if (/\bprs?\b/.test(lower)) terms.push("pull_request", "pull");
  if (UPDATE_INTENT.test(lower)) terms.push("update", "save", "status");
  // "#bugs" names a Slack channel, though the word "channel" never appears.
  if (/(?:^|[\s(])#[a-z][a-z0-9._-]*/.test(lower)) terms.push("channel", "channels");
  return [...new Set(terms)];
}

function toolHaystack(tool: ToolExecutor): string {
  return `${tool.definition.function.name} ${tool.definition.function.description}`.toLowerCase();
}

/**
 * Tools that always keep a place in the budget. Slack's read-only channel
 * tools (finding, listing and reading channels) are needed for almost any
 * Slack request, but their names rarely share a word with it: in "Post hi
 * in #bugs" nothing says "channel". Without them the agent can only find a
 * channel through message search, which misses channels with no messages
 * (found live 2026-10-24). Matched by name because Slack's MCP server
 * doesn't document exact tool names.
 */
export function isPinnedTool(tool: ToolExecutor): boolean {
  const name = tool.definition.function.name.toLowerCase();
  return !tool.mutates && name.startsWith("slack_") && name.includes("channel");
}

function scoreTool(haystack: string, name: string, terms: string[], pinned = false): number {
  const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  // Pinned tools go first. Half a point: a core tool outranks unrelated
  // tools but never a tool that actually matches a word in the request.
  return (pinned ? 100 : 0) + matches + (CORE_TOOL_NAMES.has(name) ? 0.5 : 0);
}

/**
 * Produces a bounded, compact tool surface for one LLM request. Executing a
 * tool still uses the original executor; only the schema shown to the model
 * is shortened. Relevant tools are preferred using words from the newest
 * user request, then original order is used as a deterministic tie-break.
 */
export function selectToolsForBudget(tools: ToolExecutor[], request: string, budgetTokens: number): ToolExecutor[] {
  const haystacks = tools.map(toolHaystack);
  // A word found in most tool descriptions ("linear" on a Linear server,
  // "github", "the") cannot tell the tools apart; counting it only adds the
  // same point everywhere and lets original order decide.
  const terms = requestTerms(request).filter((term) => tools.length < 5 || haystacks.filter((haystack) => haystack.includes(term)).length <= tools.length * 0.6);
  const ranked = tools
    .map((tool, index) => ({ tool, index, score: scoreTool(haystacks[index], tool.definition.function.name, terms, isPinnedTool(tool)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: ToolExecutor[] = [];
  let used = 0;
  for (const { tool } of ranked) {
    const compact = {
      ...tool,
      definition: {
        ...tool.definition,
        function: {
          ...tool.definition.function,
          description: tool.definition.function.description.slice(0, 400),
          parameters: compactSchema(tool.definition.function.parameters) as Record<string, unknown>,
        },
      },
    };
    const cost = estimateTokens(JSON.stringify(compact.definition));
    if (selected.length > 0 && used + cost > budgetTokens) continue;
    if (cost > budgetTokens) continue;
    selected.push(compact);
    used += cost;
  }
  return selected;
}

// A write proposal appears as its own interactive card. The model's second
// response often repeats "please confirm it in the UI", which is redundant
// at best and can become stale if someone approves the card before that
// response arrives. Remove only sentences that combine confirmation wording
// with proposal-card mechanics; ordinary uses of words such as "confirm"
// remain untouched.
export function stripConfirmationBoilerplate(reply: string): string {
  const kept = reply
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      if (!(/\b(confirm|cancel)\b/i.test(sentence) && /\b(pending|awaiting|card|ui|button)\b/i.test(sentence))) return sentence;
      // The model often puts the useful proposal and stale UI instruction
      // into one sentence. Keep the former by cutting only from the action
      // status / instruction phrase onward.
      return sentence
        .replace(/\s+(?:this|the)\s+(?:action|request|change|proposal)\s+(?:is|remains)\s+(?:pending|awaiting)[\s\S]*$/i, "")
        .replace(/\s+please\s+(?:confirm|cancel)\b[\s\S]*$/i, "")
        .replace(/^(?:this|the)\s+(?:action|request|change|proposal)\s+(?:is|remains)\s+(?:pending|awaiting)[\s\S]*$/i, "")
        .replace(/^please\s+(?:confirm|cancel)\b[\s\S]*$/i, "")
        .trim();
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  return kept || "Here's what I'm proposing -- see the card above.";
}

export function replyForResolvedActions(
  actions: Array<{ status: "pending" | "confirmed" | "cancelled" | "failed" }>,
  agentKind: AgentKind
): string | null {
  if (actions.length === 0 || actions.some((action) => action.status === "pending")) return null;
  const label = agentKind === "github" ? "GitHub " : agentKind === "slack" ? "Slack " : "";
  const noun = actions.length === 1 ? "action" : "actions";
  if (actions.every((action) => action.status === "confirmed")) return `The proposed ${label}${noun} ${actions.length === 1 ? "was" : "were"} confirmed and completed.`;
  if (actions.every((action) => action.status === "cancelled")) return `The proposed ${label}${noun} ${actions.length === 1 ? "was" : "were"} cancelled.`;
  if (actions.every((action) => action.status === "failed")) return `The proposed ${label}${noun} could not be completed.`;
  return null;
}

export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const chat = input.chat ?? chatCompletion;
  const config = input.llmConfig ?? resolveLlmConfig();
  const maxTurns = input.maxTurns ?? 6;
  // Workflow runs place their task in customInstructions and add only a
  // system message to the transcript. Use that task when there is no user
  // message so a release-check workflow can still prioritize its PR/CI tools.
  const toolSelectionRequest =
    [...input.history].reverse().find((message) => message.role === "user")?.content ?? input.customInstructions ?? "";
  const toolBudget = Math.max(600, Math.floor(config.tpmLimit * MAX_TOOL_SCHEMA_SHARE));
  const selectedTools = selectToolsForBudget(input.tools, toolSelectionRequest, toolBudget);
  const toolDefs = selectedTools.map((t) => t.definition);
  const toolMap = new Map(selectedTools.map((t) => [t.definition.function.name, t.execute]));

  // The connected tool schema (Slack's 2 hand-written tools, plus
  // whatever GitHub MCP tools are configured -- see github-mcp-pool.ts's
  // DEFAULT_GITHUB_TOOLS) plus this system prompt can already spend most
  // of a small per-minute token budget (see
  // llm-client.ts's LlmConfig.tpmLimit -- default 8000, matching Groq's
  // free tier) before a single word of conversation is added. Rather than
  // guess at a fixed history length, size the history window to whatever
  // budget is actually left THIS turn: total limit minus what the tools,
  // system prompt, and reserved completion tokens are already spending.
  // Found live 2026-09-20: a routine message failed with "Requested 8038"
  // against an 8000 limit, almost entirely from tool schema + system
  // prompt + the (then 4096) completion reserve, with nothing left over
  // for history at all.
  const systemPrompt = buildSystemPrompt(input.githubContext, input.agentKind, input.actionContext, input.customInstructions, input.knowledge, input.workspaceMemory, input.workflowMode, input.githubNotice, input.teamActivity, input.slackChannels);
  const toolsTokens = estimateTokens(JSON.stringify(toolDefs));
  const systemTokens = estimateTokens(systemPrompt);
  const historyBudget = config.tpmLimit - toolsTokens - systemTokens - config.maxTokens - TOKEN_BUDGET_SAFETY_MARGIN;
  const trimmedHistory = trimHistoryToBudget(input.history, historyBudget);
  // Empirical, not estimated -- lets you actually see whether your
  // configured GitHub tool set (GITHUB_TOOLS / GITHUB_TOOLSETS -- see
  // github-mcp-pool.ts and README.md) leaves any real room for
  // conversation history, instead of guessing from this project's docs.
  console.log(
    `[agent] ${selectedTools.length}/${input.tools.length} tool(s), schema ~${toolsTokens} tok, system prompt ~${systemTokens} tok, ` +
      `history budget ~${Math.max(historyBudget, 0)} tok (of ${config.tpmLimit} total, ${config.maxTokens} reserved for the reply)`
  );

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...trimmedHistory];
  let toolCallsMade = 0;
  const toolTrace: Array<{ name: string; durationMs: number; status: "succeeded" | "failed" }> = [];
  let providerPromptTokens = 0; let providerCompletionTokens = 0; let providerCostUsd: number | null = null;
  let proposedWriteAction = false;
  const proposedActionIds: string[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    // Diagnostic timing (temporary, 2026-09-21 -- tracking down reports of
    // slow replies since GitHub's MCP tools were added): wall-clock time
    // of the LLM call itself, separate from tool execution below, so a
    // slow reply can be pinned on "the model is slow to respond" vs
    // "a specific tool call is slow" instead of just one big number.
    const llmCallStart = Date.now();
    const message = await chat(config, messages, toolDefs);
    providerPromptTokens += message.usage?.promptTokens ?? 0; providerCompletionTokens += message.usage?.completionTokens ?? 0; if (message.usage?.costUsd !== undefined) providerCostUsd = (providerCostUsd ?? 0) + message.usage.costUsd;
    console.log(`[timing] LLM call (turn ${turn + 1}) took ${Date.now() - llmCallStart}ms`);
    // `usage` is our local telemetry added by llm-client, not part of the
    // OpenAI-compatible chat message schema. Keep it for the run record,
    // but never echo it into the next provider request (Groq rejects an
    // assistant message carrying an unknown `usage` property).
    const { usage: _usage, ...providerMessage } = message;
    messages.push(providerMessage);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      const reply = message.content ?? "";
      return { reply: proposedWriteAction ? stripConfirmationBoilerplate(reply) : reply, toolCallsMade, toolTrace, providerPromptTokens, providerCompletionTokens, providerCostUsd, proposedActionIds };
    }

    for (const call of message.tool_calls) {
      toolCallsMade++;
      const exec = toolMap.get(call.function.name);
      let resultText: string;
      const toolCallStart = Date.now();
      if (!exec) {
        resultText = `error: unknown tool "${call.function.name}"`;
      } else {
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const result = await exec(args);
          if (result && typeof result === "object" && (result as { status?: unknown }).status === "awaiting_user_confirmation") {
            proposedWriteAction = true;
            const actionId = (result as { actionId?: unknown }).actionId;
            if (typeof actionId === "string") proposedActionIds.push(actionId);
          }
          resultText = JSON.stringify(result);
        } catch (err) {
          resultText = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      console.log(`[timing] tool "${call.function.name}" took ${Date.now() - toolCallStart}ms`);
      toolTrace.push({ name: call.function.name, durationMs: Date.now() - toolCallStart, status: resultText.startsWith("error:") ? "failed" : "succeeded" });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: resultText });
    }
  }

  // Out of tool rounds. Rather than discarding everything the tools already
  // returned, ask once more with no tools offered so the model must answer
  // from what it has, and say what it could not check.
  let finalReply = "I wasn't able to finish that within my turn budget -- try asking something narrower.";
  try {
    messages.push({
      role: "user",
      content:
        "You have used all the tool calls available for this request. Do not call any more tools. Answer now using only the tool results above, and say briefly what you could not check.",
    });
    const final = await chat(config, messages, []);
    providerPromptTokens += final.usage?.promptTokens ?? 0; providerCompletionTokens += final.usage?.completionTokens ?? 0; if (final.usage?.costUsd !== undefined) providerCostUsd = (providerCostUsd ?? 0) + final.usage.costUsd;
    if (!final.tool_calls?.length && final.content?.trim()) finalReply = proposedWriteAction ? stripConfirmationBoilerplate(final.content) : final.content;
  } catch (error) {
    console.error(`[agent] final answer after the turn budget failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    reply: finalReply,
    toolCallsMade,
    toolTrace,
    providerPromptTokens,
    providerCompletionTokens,
    providerCostUsd,
    proposedActionIds,
  };
}
