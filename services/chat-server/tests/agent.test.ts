import { describe, it, expect } from "vitest";
import { isPinnedTool, replyForResolvedActions, runAgentTurn, selectToolsForBudget, stripConfirmationBoilerplate } from "../src/agent.js";
import type { ChatMessage, LlmChatFn } from "../src/llm-client.js";
import type { ToolExecutor } from "../src/tools.js";

// Same "mock only the non-deterministic/external call" line this project
// has drawn since its first LLM integration: only the chat() call itself
// is scripted here, everything else (tool dispatch, argument parsing,
// message threading) is the real agent.ts code.

function fakeTool(name: string, execute: (args: Record<string, unknown>) => Promise<unknown>): ToolExecutor {
  return {
    definition: { type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } },
    execute,
  };
}

describe("runAgentTurn", () => {
  it("bounds a large remote MCP tool surface and prefers a tool relevant to the request", () => {
    const bigTool = (name: string, description: string): ToolExecutor => ({
      definition: {
        type: "function",
        function: {
          name,
          description: `${description} ${"extra schema documentation ".repeat(150)}`,
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "Input for this operation ".repeat(150) },
            },
          },
        },
      },
      execute: async () => ({}),
    });
    const selected = selectToolsForBudget(
      [
        bigTool("list_channels", "List Slack channels"),
        bigTool("search_messages", "Search Slack messages"),
        ...Array.from({ length: 20 }, (_, index) => bigTool(`unrelated_${index}`, "Perform an unrelated operation")),
      ],
      "list the channels",
      300
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(22);
    expect(selected[0].definition.function.name).toBe("list_channels");
  });

  it("uses workflow instructions to choose relevant tools when there is no user message", async () => {
    const bigTool = (name: string, description: string): ToolExecutor => ({
      definition: {
        type: "function",
        function: {
          name,
          description: `${description} ${"details ".repeat(500)}`,
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => ({}),
    });
    let offeredTools: string[] = [];
    const chat: LlmChatFn = async (_config, _messages, tools) => {
      offeredTools = tools.map((tool) => tool.function.name);
      return { role: "assistant", content: "Release report" };
    };

    await runAgentTurn({
      history: [],
      customInstructions: "Review open pull requests and CI checks.",
      tools: [
        bigTool("list_issues", "List repository issues"),
        bigTool("list_pull_requests", "List open pull requests"),
        bigTool("actions_list", "List GitHub Actions workflow runs"),
      ],
      chat,
      llmConfig: { baseUrl: "http://example.invalid", apiKey: "k", model: "m", maxTokens: 10, tpmLimit: 800 },
    });

    expect(offeredTools).toContain("list_pull_requests");
    expect(offeredTools).toContain("actions_list");
  });

  it("ranks pull-request and Actions tools first when a request says PR or CI", () => {
    const tools = [
      fakeTool("get_me", async () => ({})),
      fakeTool("list_issues", async () => ({})),
      fakeTool("search_code", async () => ({})),
      fakeTool("pull_request_read", async () => ({})),
      fakeTool("actions_list", async () => ({})),
    ];
    expect(selectToolsForBudget(tools, "Review PR #17 and tell me if it is good", 5000)[0]?.definition.function.name).toBe("pull_request_read");
    expect(selectToolsForBudget(tools, "Why is CI red?", 5000)[0]?.definition.function.name).toBe("actions_list");
  });

  it("on a large Linear server, a 'move to Done and comment' request keeps the update, comment and status tools", () => {
    const linearTool = (name: string, description: string): ToolExecutor => ({
      definition: { type: "function", function: { name, description: `${description} in Linear. ${"Linear workspace details ".repeat(12)}`, parameters: { type: "object", properties: { id: { type: "string" } } } } },
      execute: async () => ({}),
    });
    const filler = Array.from({ length: 60 }, (_, index) => linearTool(`list_thing_${index}`, `List thing ${index} for a team`));
    const tools = [
      ...filler.slice(0, 30),
      linearTool("list_templates", "List templates for a team"),
      linearTool("get_team", "Get a team"),
      linearTool("save_issue", "Create or update an issue; set state, priority or assignee"),
      linearTool("save_comment", "Create or update a comment on an issue"),
      linearTool("list_issue_statuses", "List the workflow states for a team"),
      linearTool("list_issues", "List issues"),
      ...filler.slice(30),
    ];
    const selected = selectToolsForBudget(tools, 'Move "Write real unit tests" to Done in Linear and comment "Fixed by PR #17"', 1500).map((tool) => tool.definition.function.name);
    expect(selected.length).toBeLessThan(tools.length);
    expect(selected).toEqual(expect.arrayContaining(["save_issue", "save_comment", "list_issue_statuses"]));
  });

  it("prioritizes issue_write when a workflow explicitly requests a governed issue", () => {
    const selected = selectToolsForBudget(
      [
        fakeTool("list_issues", async () => ({})),
        fakeTool("issue_write", async () => ({})),
      ],
      "Create a GitHub issue. Use issue_write with method create to make a pending approval proposal.",
      600
    );
    expect(selected[0]?.definition.function.name).toBe("issue_write");
  });

  it("returns the plain reply when the model doesn't call any tool", async () => {
    const chat: LlmChatFn = async () => ({ role: "assistant", content: "Hello there!" });
    const result = await runAgentTurn({ history: [{ role: "user", content: "hi" }], tools: [], chat });
    expect(result.reply).toBe("Hello there!");
    expect(result.toolCallsMade).toBe(0);
  });

  it("tells automated workflows to complete the task instead of acknowledging it", async () => {
    let systemPrompt = "";
    const chat: LlmChatFn = async (_config, messages) => {
      systemPrompt = String(messages[0]?.content);
      return { role: "assistant", content: "Completed." };
    };
    await runAgentTurn({
      history: [],
      tools: [],
      customInstructions: "Prepare a release-readiness update.",
      workflowMode: true,
      chat,
    });
    expect(systemPrompt).toContain("AUTOMATED WORKFLOW EXECUTION");
    expect(systemPrompt).toContain("Do not merely acknowledge it");
  });

  it("executes a real tool call, feeds the result back, and returns the model's follow-up reply", async () => {
    let call = 0;
    const chat: LlmChatFn = async (_config, messages) => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
        };
      }
      // Second call: the tool result should now be in the message history as a "tool" role message.
      const toolMessage = messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("sunny");
      return { role: "assistant", content: "It's sunny in SF!" };
    };
    const tools = [fakeTool("get_weather", async (args) => ({ city: args.city, weather: "sunny" }))];
    const result = await runAgentTurn({ history: [{ role: "user", content: "weather in SF?" }], tools, chat });
    expect(result.reply).toBe("It's sunny in SF!");
    expect(result.toolCallsMade).toBe(1);
  });

  it("handles multiple tool calls in one turn", async () => {
    let call = 0;
    const executed: string[] = [];
    const chat: LlmChatFn = async () => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "tool_a", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "tool_b", arguments: "{}" } },
          ],
        };
      }
      return { role: "assistant", content: "done with both" };
    };
    const tools = [
      fakeTool("tool_a", async () => {
        executed.push("a");
        return "result a";
      }),
      fakeTool("tool_b", async () => {
        executed.push("b");
        return "result b";
      }),
    ];
    const result = await runAgentTurn({ history: [{ role: "user", content: "do both" }], tools, chat });
    expect(result.reply).toBe("done with both");
    expect(result.toolCallsMade).toBe(2);
    expect(executed.sort()).toEqual(["a", "b"]);
  });

  it("feeds a tool execution error back to the model instead of throwing", async () => {
    let call = 0;
    const chat: LlmChatFn = async (_config, messages) => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "x", type: "function", function: { name: "flaky_tool", arguments: "{}" } }],
        };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("error:");
      expect(toolMessage?.content).toContain("boom");
      return { role: "assistant", content: "That tool failed, sorry." };
    };
    const tools = [
      fakeTool("flaky_tool", async () => {
        throw new Error("boom");
      }),
    ];
    const result = await runAgentTurn({ history: [{ role: "user", content: "try it" }], tools, chat });
    expect(result.reply).toBe("That tool failed, sorry.");
  });

  it("reports an unknown tool name back to the model rather than crashing", async () => {
    let call = 0;
    const chat: LlmChatFn = async (_config, messages) => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "y", type: "function", function: { name: "nonexistent_tool", arguments: "{}" } }],
        };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("unknown tool");
      return { role: "assistant", content: "I don't have that capability." };
    };
    const result = await runAgentTurn({ history: [{ role: "user", content: "?" }], tools: [], chat });
    expect(result.reply).toBe("I don't have that capability.");
  });

  it("stops after maxTurns and returns a clear message instead of looping forever", async () => {
    const chat: LlmChatFn = async () => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "loop", type: "function", function: { name: "loopy", arguments: "{}" } }],
    });
    const tools = [fakeTool("loopy", async () => "again")];
    const result = await runAgentTurn({ history: [{ role: "user", content: "loop" }], tools, chat, maxTurns: 2 });
    expect(result.reply).toContain("turn budget");
    expect(result.toolCallsMade).toBe(2);
  });

  it("after the last tool round, answers from the results gathered so far instead of discarding them", async () => {
    let calls = 0;
    let finalToolsOffered: number | null = null;
    const chat: LlmChatFn = async (_config, messages, tools) => {
      calls++;
      if (calls <= 2) return { role: "assistant", content: null, tool_calls: [{ id: `c${calls}`, type: "function", function: { name: "read_pr", arguments: "{}" } }] };
      finalToolsOffered = tools.length;
      expect(messages[messages.length - 1].content).toContain("Do not call any more tools");
      return { role: "assistant", content: "PR #17 fixes test.py; I could not check its CI status." };
    };
    const tools = [fakeTool("read_pr", async () => "PR #17 changes test.py")];
    const result = await runAgentTurn({ history: [{ role: "user", content: "review PR #17" }], tools, chat, maxTurns: 2 });
    expect(result.reply).toBe("PR #17 fixes test.py; I could not check its CI status.");
    expect(finalToolsOffered).toBe(0);
    expect(result.toolCallsMade).toBe(2);
  });

  it("tells every specialist to propose a restated write again after an earlier failure", async () => {
    for (const agentKind of ["github", "slack", "linear", "notion", "figma"] as const) {
      let systemPrompt = "";
      const chat: LlmChatFn = async (_config, messages) => {
        systemPrompt = String(messages[0]?.content);
        return { role: "assistant", content: "ok" };
      };
      await runAgentTurn({ history: [{ role: "user", content: "create the page again" }], tools: [], chat, agentKind });
      expect(systemPrompt).toContain("Earlier failures");
      expect(systemPrompt).toContain("Never say a tool is unavailable when");
    }
  });

  it("puts the system prompt first and preserves the given history order", async () => {
    let seenMessages: ChatMessage[] = [];
    const chat: LlmChatFn = async (_config, messages) => {
      // Snapshot the array now: agent.ts intentionally mutates `messages` in
      // place (push) after this callback returns, to build up the transcript
      // across turns -- holding onto the live reference here would see that
      // later push too, once the request has already resolved.
      seenMessages = messages.slice();
      return { role: "assistant", content: "ok" };
    };
    const history: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    await runAgentTurn({ history, tools: [], chat });
    expect(seenMessages[0].role).toBe("system");
    expect(seenMessages.slice(1)).toEqual(history);
  });

  it("tells the model which repo is connected when githubContext is given, and says none is connected otherwise", async () => {
    let seenSystemPrompt = "";
    const chat: LlmChatFn = async (_config, messages) => {
      seenSystemPrompt = String(messages[0].content);
      return { role: "assistant", content: "ok" };
    };
    await runAgentTurn({ history: [], tools: [], chat, githubContext: { owner: "octocat", repo: "hello-world" } });
    expect(seenSystemPrompt).toContain("octocat/hello-world");

    await runAgentTurn({ history: [], tools: [], chat });
    expect(seenSystemPrompt).toContain("No GitHub repository is connected");
  });

  it("tells the GitHub agent its one repository, whose account it acts as, what that account can do, and recent team activity", async () => {
    let seenSystemPrompt = "";
    const chat: LlmChatFn = async (_config, messages) => {
      seenSystemPrompt = String(messages[0].content);
      return { role: "assistant", content: "ok" };
    };
    await runAgentTurn({
      history: [],
      tools: [],
      chat,
      agentKind: "github",
      githubContext: { owner: "acme", repo: "web", access: "write", account: "stevens-gh", actingAs: "Stevens" },
      teamActivity: "- Hena's agent made a comment on #14 in acme/web (5 minutes ago)",
    });
    expect(seenSystemPrompt).toContain("works in ONE GitHub repository: acme/web (can read and propose changes)");
    expect(seenSystemPrompt).toContain("Stevens's own GitHub account (@stevens-gh)");
    expect(seenSystemPrompt).toContain('Always pass owner="acme"');
    expect(seenSystemPrompt).toContain("Never use a different repository");
    expect(seenSystemPrompt).toContain("change\ntheir repository under Integrations → GitHub");
    expect(seenSystemPrompt).toContain("Hena's agent made a comment on #14");

    await runAgentTurn({ history: [], tools: [], chat, agentKind: "github", githubContext: { owner: "acme", repo: "secret", access: "none", account: "stevens-gh", actingAs: "Stevens" } });
    expect(seenSystemPrompt).toContain('say "Your GitHub account (@stevens-gh) can\'t access acme/secret"');

    await runAgentTurn({ history: [], tools: [], chat, agentKind: "github", githubContext: { owner: "acme", repo: "docs", access: "read", account: "stevens-gh", actingAs: "Stevens" } });
    expect(seenSystemPrompt).toContain("can read acme/docs but cannot make changes there");

    await runAgentTurn({ history: [], tools: [], chat, agentKind: "github", githubNotice: "Casey connected GitHub but hasn't chosen a repository yet." });
    expect(seenSystemPrompt).toContain("Casey connected GitHub but hasn't chosen a repository yet");
    expect(seenSystemPrompt).not.toContain("No GitHub repository is connected");
  });

  it("includes trusted action status so follow-up questions can report a confirmed action accurately", async () => {
    let seenSystemPrompt = "";
    const chat: LlmChatFn = async (_config, messages) => {
      seenSystemPrompt = String(messages[0].content);
      return { role: "assistant", content: "The issue was created." };
    };
    await runAgentTurn({
      history: [{ role: "user", content: "Is the action completed?" }],
      tools: [],
      actionContext: "- Create issue: Approval status: confirmed",
      chat,
    });
    expect(seenSystemPrompt).toContain("Trusted action status for this conversation");
    expect(seenSystemPrompt).toContain("Create issue: Approval status: confirmed");
    expect(seenSystemPrompt).toContain("A confirmed action has completed");
  });

  it("passes workflow instructions and durable workspace memory into the agent prompt", async () => {
    let seenSystemPrompt = "";
    const chat: LlmChatFn = async (_config, messages) => {
      seenSystemPrompt = String(messages[0].content);
      return { role: "assistant", content: "Release readiness report" };
    };
    await runAgentTurn({
      history: [],
      tools: [],
      customInstructions: "WORKFLOW INSTRUCTIONS — complete this task for the team:\nReview CI and release blockers.",
      workspaceMemory: "[Memory: Release policy] (decision; current through 2026-12-31)\nRelease from main only.",
      chat,
    });
    expect(seenSystemPrompt).toContain("Review CI and release blockers.");
    expect(seenSystemPrompt).toContain("[Memory: Release policy]");
    expect(seenSystemPrompt).toContain("Cite a memory by its exact [Memory: title] label");
    expect(seenSystemPrompt).toContain("Never say that a missing repository prevents access to workspace memory");
    expect(seenSystemPrompt.lastIndexOf("DURABLE WORKSPACE MEMORY")).toBeGreaterThan(
      seenSystemPrompt.lastIndexOf("No GitHub repository is connected"),
    );
  });

  it("trims older history to fit the configured token budget, keeping the most recent messages and their order", async () => {
    let seenMessages: ChatMessage[] = [];
    const chat: LlmChatFn = async (_config, messages) => {
      seenMessages = messages.slice();
      return { role: "assistant", content: "ok" };
    };
    const history: ChatMessage[] = [
      { role: "user", content: "a very very very very very very very long old message that should get dropped" },
      { role: "assistant", content: "an equally long old reply that should also get dropped from history" },
      { role: "user", content: "short recent message" },
    ];
    // A tiny tpmLimit forces the history budget down to almost nothing --
    // this project's real config would never be this small, but it's the
    // simplest way to exercise the trimming path deterministically (see
    // token-budget.test.ts for trimHistoryToBudget's own unit tests).
    await runAgentTurn({
      history,
      tools: [],
      chat,
      llmConfig: { baseUrl: "http://example.invalid", apiKey: "k", model: "m", maxTokens: 10, tpmLimit: 60 },
    });
    expect(seenMessages[0].role).toBe("system");
    const forwardedHistory = seenMessages.slice(1);
    expect(forwardedHistory.length).toBeLessThan(history.length);
    expect(forwardedHistory[forwardedHistory.length - 1]).toEqual(history[history.length - 1]);
  });

  // Found live 2026-09-21: after proposing a write action, the model kept
  // telling the user to "click Confirm on the card" -- redundant (the
  // card already has its own buttons) and sometimes flatly stale, since
  // this reply is a SECOND LLM call that can finish after a fast human
  // already clicked Confirm. The system prompt asks the model not to say
  // this, but this project's default local model doesn't reliably follow
  // that, so runAgentTurn strips it deterministically whenever a tool
  // call this turn came back "awaiting_user_confirmation" -- see
  // stripConfirmationBoilerplate.
  it("strips redundant confirm/cancel chatter from the reply after proposing a write action", async () => {
    let call = 0;
    const chat: LlmChatFn = async () => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "open_issue", arguments: "{}" } }],
        };
      }
      return {
        role: "assistant",
        content:
          'I\'m preparing to create a new issue titled **"team meeting."**\n\nThis action is pending -- please confirm it in the card that just appeared.',
      };
    };
    const tools = [fakeTool("open_issue", async () => ({ status: "awaiting_user_confirmation", actionId: "a1", description: "open an issue" }))];
    const result = await runAgentTurn({ history: [{ role: "user", content: "open an issue" }], tools, chat });
    expect(result.reply).toContain("team meeting");
    expect(result.reply.toLowerCase()).not.toContain("confirm");
    expect(result.reply.toLowerCase()).not.toContain("card");
    expect(result.proposedActionIds).toEqual(["a1"]);
  });

  it("leaves the reply alone when no tool call proposed a write action this turn", async () => {
    const chat: LlmChatFn = async () => ({
      role: "assistant",
      content: "Sure -- I opened an issue titled \"confirm meeting time\" for the team to track.",
    });
    const result = await runAgentTurn({ history: [{ role: "user", content: "hi" }], tools: [], chat });
    expect(result.reply).toBe('Sure -- I opened an issue titled "confirm meeting time" for the team to track.');
  });
});

describe("stripConfirmationBoilerplate", () => {
  it("drops a paragraph that just tells the human to confirm/cancel via the card", () => {
    const reply = stripConfirmationBoilerplate(
      'I\'m proposing to open an issue titled "Team meeting".\n\nThis action is pending -- please confirm it in the card that just appeared.'
    );
    expect(reply).toBe('I\'m proposing to open an issue titled "Team meeting".');
  });

  it("handles the confirm/cancel sentence sharing a line with real content, including trailing markdown", () => {
    const reply = stripConfirmationBoilerplate(
      'I\'m preparing to create a new issue titled **"hena."** This action is pending – please confirm it in the card that just appeared.'
    );
    expect(reply).toBe('I\'m preparing to create a new issue titled **"hena."**');
  });

  it("leaves a sentence alone when it only has a confirm/cancel word, with no UI-mechanics word alongside it", () => {
    const reply = stripConfirmationBoilerplate('Sure, I opened an issue titled "confirm meeting time" for the team to track.');
    expect(reply).toBe('Sure, I opened an issue titled "confirm meeting time" for the team to track.');
  });

  it("falls back to a short static line if stripping would empty the reply out entirely", () => {
    const reply = stripConfirmationBoilerplate("Please confirm it in the card that just appeared.");
    expect(reply).toBe("Here's what I'm proposing -- see the card above.");
  });

  it("leaves an unrelated reply untouched", () => {
    const reply = stripConfirmationBoilerplate("The weather in SF is sunny today.");
    expect(reply).toBe("The weather in SF is sunny today.");
  });
});

describe("replyForResolvedActions", () => {
  it("replaces a stale proposal reply after its action has already been confirmed", () => {
    expect(replyForResolvedActions([{ status: "confirmed" }], "github")).toBe(
      "The proposed GitHub action was confirmed and completed."
    );
  });

  it("keeps the model reply when an action is still awaiting a decision", () => {
    expect(replyForResolvedActions([{ status: "pending" }], "github")).toBeNull();
  });
});

describe("finding Slack channels by name", () => {
  // Regression, found live 2026-10-24: "Post ... in #bugs" left Slack's
  // channel-search tool out of a tight tool budget, so the agent looked for
  // #bugs with message search, missed it (it had no messages) and proposed
  // posting to #engineering instead.
  const bigTool = (name: string, description: string, mutates = false): ToolExecutor => ({
    definition: { type: "function", function: { name, description: `${description} ${"details ".repeat(300)}`, parameters: { type: "object", properties: {} } } },
    mutates,
    execute: async () => ({}),
  });
  const slackTools = [
    bigTool("slack_send_message", "Post a message to a channel", true),
    bigTool("slack_search_public", "Search messages in public channels"),
    ...Array.from({ length: 10 }, (_, index) => bigTool(`slack_other_${index}`, "Post or search something else in Slack")),
    bigTool("slack_search_channels", "Find conversations by name"),
    bigTool("slack_read_channel", "Read conversation history"),
  ];

  it("always keeps the read-only channel tools, even when nothing in the request mentions them", () => {
    const selected = selectToolsForBudget(slackTools, 'Post "Hello" in #bugs', 400).map((tool) => tool.definition.function.name);
    expect(selected.length).toBeLessThan(slackTools.length);
    expect(selected).toEqual(expect.arrayContaining(["slack_search_channels", "slack_read_channel"]));
  });

  it("keeps them even when the request doesn't name a channel at all", () => {
    const selected = selectToolsForBudget(slackTools, "Tell the bugs team hello", 400).map((tool) => tool.definition.function.name);
    expect(selected.length).toBeLessThan(slackTools.length);
    expect(selected).toEqual(expect.arrayContaining(["slack_search_channels", "slack_read_channel"]));
  });

  it("pins only read-only Slack tools whose name is about channels", () => {
    expect(isPinnedTool(bigTool("slack_search_channels", "x"))).toBe(true);
    expect(isPinnedTool(bigTool("slack_post_to_channel", "x", true))).toBe(false);
    expect(isPinnedTool(bigTool("list_channels", "x"))).toBe(false);
  });

  it("gives the Slack agent the looked-up channels and tells it never to substitute another", async () => {
    let systemPrompt = "";
    const chat: LlmChatFn = async (_config, messages) => {
      systemPrompt = String(messages[0].content);
      return { role: "assistant", content: "ok" };
    };
    await runAgentTurn({
      history: [{ role: "user", content: 'Post "Hello" in #bugs and #nope' }],
      tools: [],
      agentKind: "slack",
      slackChannels: "- #bugs = channel ID C0BUGS1234\n- #nope: not found among the channels this member can see",
      chat,
      llmConfig: { baseUrl: "http://example.invalid", apiKey: "k", model: "m", maxTokens: 10, tpmLimit: 8000 },
    });
    expect(systemPrompt).toContain("#bugs = channel ID C0BUGS1234");
    expect(systemPrompt).toContain("never use a different channel instead");
    expect(systemPrompt).toContain("Never post to a channel other than the one the person named");
  });
});

describe("approval rules in the agent's instructions", () => {
  async function promptFor(agentKind: "github" | "project", approvalRules: string | null) {
    let systemPrompt = "";
    const chat: LlmChatFn = async (_config, messages) => {
      systemPrompt = String(messages[0].content);
      return { role: "assistant", content: "ok" };
    };
    await runAgentTurn({
      history: [{ role: "user", content: "Merge PR #4" }],
      tools: [],
      agentKind,
      approvalRules,
      chat,
      llmConfig: { baseUrl: "http://example.invalid", apiKey: "k", model: "m", maxTokens: 10, tpmLimit: 8000 },
    });
    return systemPrompt;
  }
  const rules = '- "Production merges": GitHub: merge on main needs 2 approvals from people other than the requester.';

  it("tells a tool agent the rules and how to act on them", async () => {
    const prompt = await promptFor("github", rules);
    expect(prompt).toContain(rules);
    expect(prompt).toContain("do not propose it: tell the person which rule prevents it");
    expect(prompt).toContain("assume the stricter rule applies");
  });

  it("leaves them out when there are none, and for the Project agent, which can't write", async () => {
    expect(await promptFor("github", null)).not.toContain("Workspace approval rules");
    expect(await promptFor("project", rules)).not.toContain("Workspace approval rules");
  });
});
