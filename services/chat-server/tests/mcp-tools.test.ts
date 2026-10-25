import { describe, it, expect, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { mcpToolToExecutor, listMcpToolExecutors, normalizeGithubArguments } from "../src/mcp-tools.js";

function fakeClient(overrides: Partial<Client> = {}): Client {
  return {
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    ...overrides,
  } as unknown as Client;
}

function tool(overrides: Partial<McpTool> & { name: string }): McpTool {
  return {
    description: "a tool",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  } as McpTool;
}

describe("mcpToolToExecutor", () => {
  it("treats readOnlyHint: true as non-mutating, with no describe/preview", () => {
    const executor = mcpToolToExecutor(fakeClient(), tool({ name: "issue_read", annotations: { readOnlyHint: true } }));
    expect(executor.mutates).toBeFalsy();
    expect(executor.describe).toBeUndefined();
    expect(executor.preview).toBeUndefined();
  });

  it("treats readOnlyHint: false as mutating, with a describe() and preview()", () => {
    const executor = mcpToolToExecutor(fakeClient(), tool({ name: "issue_write", annotations: { readOnlyHint: false } }));
    expect(executor.mutates).toBe(true);
    expect(typeof executor.describe).toBe("function");
    expect(typeof executor.preview).toBe("function");
  });

  // Safety net: GitHub's own MCP server is verified (see mcp-tools.ts's
  // top comment) to always set readOnlyHint explicitly, but this project
  // shouldn't silently let an unclassified tool run unconfirmed if that
  // ever isn't true -- for a different/future MCP server, or a
  // regression. Missing the hint must default to mutating, not read-only.
  it("defaults a tool with no annotations at all to mutating (fail safe)", () => {
    const executor = mcpToolToExecutor(fakeClient(), tool({ name: "mystery_tool" }));
    expect(executor.mutates).toBe(true);
  });

  it("describe() surfaces the method argument for github-mcp-server's dispatch-style tools", () => {
    const executor = mcpToolToExecutor(fakeClient(), tool({ name: "issue_write", annotations: { readOnlyHint: false } }));
    expect(executor.describe!({ method: "create", title: "Bug" })).toContain("create");
    expect(executor.describe!({})).not.toThrow;
    expect(typeof executor.describe!({})).toBe("string");
  });

  it("preview() lists every argument in full, caps only runaway values visibly, and flags a destructive tool", () => {
    const executor = mcpToolToExecutor(
      fakeClient(),
      tool({ name: "delete_file", annotations: { readOnlyHint: false, destructiveHint: true } })
    );
    // The card used to cut each value at 500 characters, so hidden content
    // could pass review. Ordinary long values are now shown in full.
    const longValue = "x".repeat(1000);
    const preview = executor.preview!({ path: "src/x.ts", content: longValue });
    expect(preview).toContain("path: src/x.ts");
    expect(preview).toContain("cannot be undone");
    expect(preview).toContain(longValue);
    const runaway = executor.preview!({ content: "y".repeat(25_000) });
    expect(runaway).toContain("[… 5,000 more characters not shown]");
  });

  it("preview() never throws on an empty args object", () => {
    const executor = mcpToolToExecutor(fakeClient(), tool({ name: "issue_write", annotations: { readOnlyHint: false } }));
    expect(() => executor.preview!({})).not.toThrow();
    expect(typeof executor.preview!({})).toBe("string");
  });

  it("execute() calls the MCP client and joins text content blocks", async () => {
    const callTool = vi.fn(async () => ({
      content: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
    }));
    const executor = mcpToolToExecutor(fakeClient({ callTool }), tool({ name: "get_file_contents", annotations: { readOnlyHint: true } }));
    const result = await executor.execute({ owner: "o", repo: "r", path: "README.md" });
    expect(callTool).toHaveBeenCalledWith({ name: "get_file_contents", arguments: { owner: "o", repo: "r", path: "README.md" } });
    expect(result).toBe("first line\nsecond line");
  });

  it("accepts lowercase enum values from the model and sends the GitHub MCP form", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const executor = mcpToolToExecutor(fakeClient({ callTool }), tool({
      name: "list_issues",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { state: { type: "string", enum: ["OPEN", "CLOSED"] } } },
    }));
    expect((executor.definition.function.parameters.properties as Record<string, { enum: string[] }>).state.enum).toContain("open");
    await executor.execute({ owner: "o", repo: "r", state: "open" });
    expect(callTool).toHaveBeenCalledWith({ name: "list_issues", arguments: { owner: "o", repo: "r", state: "OPEN" } });
  });

  it("keeps each tool's own enum casing: list_pull_requests wants lowercase, so OPEN/ALL become open/all", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const executor = mcpToolToExecutor(fakeClient({ callTool }), tool({
      name: "list_pull_requests",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { state: { type: "string", enum: ["open", "closed", "all"] } } },
    }));
    await executor.execute({ owner: "o", repo: "r", state: "open" });
    expect(callTool).toHaveBeenLastCalledWith({ name: "list_pull_requests", arguments: { owner: "o", repo: "r", state: "open" } });
    await executor.execute({ owner: "o", repo: "r", state: "ALL" });
    expect(callTool).toHaveBeenLastCalledWith({ name: "list_pull_requests", arguments: { owner: "o", repo: "r", state: "all" } });
  });

  it("execute() logs and throws when the MCP result is marked isError, using its text as the message", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "404: no such issue" }], isError: true }));
    const executor = mcpToolToExecutor(fakeClient({ callTool }), tool({ name: "issue_read", annotations: { readOnlyHint: true } }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(executor.execute({ number: 999 })).rejects.toThrow("404: no such issue");
    expect(errorSpy).toHaveBeenCalledWith('[mcp] tool "issue_read" failed: 404: no such issue');
    errorSpy.mockRestore();
  });
});

describe("normalizeGithubArguments", () => {
  it("drops ref HEAD for get_file_contents so the default branch is read", () => {
    expect(normalizeGithubArguments("get_file_contents", { owner: "o", repo: "r", path: "index.html", ref: "HEAD" })).toEqual({ owner: "o", repo: "r", path: "index.html" });
    expect(normalizeGithubArguments("get_file_contents", { owner: "o", repo: "r", path: "a", ref: "refs/heads/HEAD" })).toEqual({ owner: "o", repo: "r", path: "a" });
    expect(normalizeGithubArguments("get_file_contents", { owner: "o", repo: "r", path: "a", ref: "main" })).toEqual({ owner: "o", repo: "r", path: "a", ref: "main" });
  });
  it("moves standard issue fields out of issue_fields while preserving custom fields", () => {
    expect(normalizeGithubArguments("issue_write", {
      method: "create",
      issue_fields: [
        { field_name: "title", value: "Agent test" },
        { field_name: "body", value: "Created by the agent." },
        { field_name: "Priority", value: "High" },
      ],
    })).toEqual({
      method: "create",
      title: "Agent test",
      body: "Created by the agent.",
      issue_fields: [{ field_name: "Priority", value: "High" }],
    });
  });
});

describe("approval card wording names the connected provider", () => {
  it("describes a Slack or Linear write as running on that service, not GitHub", () => {
    const slack = mcpToolToExecutor(fakeClient(), tool({ name: "slack_send_message", annotations: { readOnlyHint: false } }), "Slack");
    expect(slack.describe?.({ channel_id: "C1", message: "hi" })).toBe('Run "slack send message" on Slack');
    const linear = mcpToolToExecutor(fakeClient(), tool({ name: "save_issue", annotations: { readOnlyHint: false } }), "Linear");
    expect(linear.describe?.({ method: "update" })).toBe('Run "save issue" (update) on Linear');
  });

  it("still defaults to GitHub for GitHub's own MCP tools", () => {
    const github = mcpToolToExecutor(fakeClient(), tool({ name: "add_issue_comment", annotations: { readOnlyHint: false } }));
    expect(github.describe?.({})).toBe('Run "add issue comment" on GitHub');
  });

  it("labels every tool from listMcpToolExecutors with the given provider", async () => {
    const client = fakeClient({ listTools: async () => ({ tools: [{ name: "slack_send_message", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }] }) } as never);
    const [executor] = await listMcpToolExecutors(client, "Slack");
    expect(executor.describe?.({})).toBe('Run "slack send message" on Slack');
  });
});

describe("listMcpToolExecutors", () => {
  it("converts every tool the client reports", async () => {
    const client = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [
          tool({ name: "get_me", annotations: { readOnlyHint: true } }),
          tool({ name: "create_pull_request", annotations: { readOnlyHint: false } }),
        ],
      })),
    });
    const executors = await listMcpToolExecutors(client);
    expect(executors.map((e) => e.definition.function.name)).toEqual(["get_me", "create_pull_request"]);
    expect(executors[0].mutates).toBeFalsy();
    expect(executors[1].mutates).toBe(true);
  });
});
