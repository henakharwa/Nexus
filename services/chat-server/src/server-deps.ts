// Injectable dependencies for the chat server (real defaults, test overrides).
import { runAgentTurn as defaultRunAgentTurn } from "./agent.js";
import { createGithubClient, createSlackClient } from "@mai-chat/integrations";
import { listMcpToolExecutors } from "./mcp-tools.js";
import { DEFAULT_GITHUB_TOOLS, getGithubMcpClient } from "./github-mcp-pool.js";
import { getSlackMcpClient } from "./slack-mcp-pool.js";
import { defaultGithubOAuthDeps } from "./github-oauth.js";
import { defaultSlackOAuthDeps } from "./slack-oauth.js";
import { createMailer, defaultMailerConfig } from "./mailer.js";
import type { GithubClient, SlackClient } from "@mai-chat/integrations";
import type { ToolExecutor } from "./tools.js";
import { createGithubTeamApi, type GithubTeamApi } from "./github-api.js";
import { createSlackChannelLookup, type SlackChannelLookup } from "./slack-channels.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "./agent.js";
import type { UserAuthDeps } from "./auth.js";
import type { Mailer } from "./mailer.js";
import type { GithubOAuthConfig, GithubOAuthDeps } from "./github-oauth.js";
import type { SlackOAuthConfig, SlackOAuthDeps } from "./slack-oauth.js";

export interface CreateServerDeps {
  userAuthDeps?: UserAuthDeps;
  // Used ONLY to verify a pasted GitHub token/owner/repo before saving it
  // (the two /integrations/github... routes below) -- NOT the agent's
  // GitHub tool source anymore. See githubMcpToolsFactory for that.
  githubClientFactory: (opts: { token: string; owner: string; repo: string }) => GithubClient;
  // Release Notes' "Share to Slack" action only -- see the note on
  // packages/integrations/src/slack.ts's SlackClient.
  slackClientFactory: (opts: { token: string }) => SlackClient;
  // The agent's actual GitHub tool surface: spawns (or reuses) this
  // workspace's own GitHub MCP server process and returns its tools
  // converted to this project's ToolExecutor shape. Injectable so tests
  // can supply canned tools without spawning a real subprocess -- see
  // github-mcp-pool.ts / mcp-tools.ts for the real implementation.
  // accountKey separates members of one workspace, so each member's
  // account keeps its own server process.
  githubMcpToolsFactory: (opts: { workspaceId: string; token: string; accountKey?: string }) => Promise<ToolExecutor[]>;
  // The agent's actual Slack tool surface -- connects to (or reuses a
  // connection to) Slack's own official MCP server with this workspace's
  // stored OAuth access token and returns its tools converted to this
  // project's ToolExecutor shape. Replaces the old hand-rolled
  // buildSlackTools()/packages/integrations/src/slack.ts client entirely
  // -- see slack-mcp-pool.ts / slack-oauth.ts. Injectable so tests can
  // supply canned tools without a real network call to mcp.slack.com.
  slackMcpToolsFactory: (opts: { workspaceId: string; accessToken: string }) => Promise<ToolExecutor[]>;
  runAgentTurn: (input: RunAgentTurnInput) => Promise<RunAgentTurnResult>;
  // Sends password-reset and email-verification mail. Injectable so
  // tests never hit a real provider -- the default (no RESEND_API_KEY
  // configured) just logs the message, which is enough for tests to
  // assert against (and safe/harmless if a test run leaves it on).
  mailer: Mailer;
  // GitHub OAuth login ("+ Add channel" in the UI) -- config comes from
  // env vars by default (see defaultGithubOAuthConfig below); deps are
  // injectable so tests never hit github.com for real.
  githubOAuthConfig: GithubOAuthConfig;
  githubOAuthDeps: GithubOAuthDeps;
  // Slack OAuth login -- the ONLY way to connect Slack now (see
  // slack-oauth.ts's own comment for why there's no pasted-token
  // fallback the way GitHub has one).
  slackOAuthConfig: SlackOAuthConfig;
  slackOAuthDeps: SlackOAuthDeps;
  // Checks that a Figma token can open a team before it is saved as the
  // team the agent may browse. Defaults to figma-tools.ts's listFigmaTeamProjects.
  figmaTeamLoader?: (token: string, teamId: string) => Promise<{ teamName?: string }>;
  // GitHub account names, repository access, duplicate checks and
  // webhooks. Omitted in tests, which then never reach github.com (access
  // is "unknown").
  githubTeamApi?: GithubTeamApi;
  // Slack channel name for an ID, for approval rules written with names.
  // Omitted in tests, which then never reach slack.com (the name is unknown).
  slackChannelLookup?: SlackChannelLookup;
}

// Real implementation of githubMcpToolsFactory above -- spawns (or, for an
// unchanged token, reuses) this workspace's GitHub MCP server container
// via the module-level pool in github-mcp-pool.ts (`docker run` under the
// hood), and converts its tool list via mcp-tools.ts. Requires Docker
// Desktop installed and running -- see README.md's "GitHub tools via MCP
// server" section. GITHUB_MCP_DOCKER_IMAGE can override the image (e.g.
// to pin a version) if left unset it defaults to GitHub's own published
// ghcr.io/github/github-mcp-server.
export async function defaultGithubMcpToolsFactory(opts: { workspaceId: string; token: string; accountKey?: string }): Promise<ToolExecutor[]> {
  const client = await getGithubMcpClient(opts.workspaceId, {
    accountKey: opts.accountKey,
    token: opts.token,
    image: process.env.GITHUB_MCP_DOCKER_IMAGE,
    // Render retains a blank variable as an empty string. `??` treats that
    // as configured, which made GITHUB_TOOLS= select GitHub MCP's large
    // default surface instead of this curated list and overflow Groq.
    toolsets: process.env.GITHUB_TOOLSETS || undefined,
    // GitHub MCP adds explicit tools to selected toolsets. Keep the curated
    // base set when Actions (or another toolset) is enabled, unless an operator
    // deliberately provides a complete GITHUB_TOOLS override.
    tools: process.env.GITHUB_TOOLS || DEFAULT_GITHUB_TOOLS,
  });
  return listMcpToolExecutors(client, "GitHub");
}

// Real implementation of slackMcpToolsFactory above -- connects to (or
// reuses a connection to) Slack's own official MCP server via the
// module-level pool in slack-mcp-pool.ts, using this workspace's stored
// Slack OAuth access token, and converts its tool list via the same
// generic mcp-tools.ts conversion GitHub's tools already go through.
// SLACK_MCP_SERVER_URL can override the endpoint (e.g. for a local
// stand-in during development); unset defaults to Slack's real
// https://mcp.slack.com/mcp.
export async function defaultSlackMcpToolsFactory(opts: { workspaceId: string; accessToken: string }): Promise<ToolExecutor[]> {
  const client = await getSlackMcpClient(opts.workspaceId, {
    accessToken: opts.accessToken,
    serverUrl: process.env.SLACK_MCP_SERVER_URL || undefined,
  });
  return listMcpToolExecutors(client, "Slack");
}

// Centralized here (rather than read ad hoc at each call site) so tests can
// pass a whole config object instead of mutating process.env.
export function defaultGithubOAuthConfig(): GithubOAuthConfig {
  const publicUrl = process.env.CHAT_SERVER_PUBLIC_URL ?? `http://localhost:${process.env.CHAT_SERVER_PORT ?? 4000}`;
  return {
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
    redirectUri: `${publicUrl.replace(/\/$/, "")}/auth/github/callback`,
    webAppUrl: process.env.WEB_APP_URL ?? "http://localhost:3000",
  };
}

export function defaultSlackOAuthConfig(): SlackOAuthConfig {
  const publicUrl = process.env.CHAT_SERVER_PUBLIC_URL ?? `http://localhost:${process.env.CHAT_SERVER_PORT ?? 4000}`;
  return {
    clientId: process.env.SLACK_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.SLACK_OAUTH_CLIENT_SECRET ?? "",
    redirectUri: `${publicUrl.replace(/\/$/, "")}/auth/slack/callback`,
    webAppUrl: process.env.WEB_APP_URL ?? "http://localhost:3000",
  };
}

let sharedGithubTeamApi: GithubTeamApi | undefined;

export const defaultDeps: CreateServerDeps = {
  githubClientFactory: createGithubClient,
  slackClientFactory: createSlackClient,
  githubMcpToolsFactory: defaultGithubMcpToolsFactory,
  slackMcpToolsFactory: defaultSlackMcpToolsFactory,
  runAgentTurn: defaultRunAgentTurn,
  get mailer() {
    return createMailer(defaultMailerConfig());
  },
  get githubOAuthConfig() {
    return defaultGithubOAuthConfig();
  },
  githubOAuthDeps: defaultGithubOAuthDeps,
  get slackOAuthConfig() {
    return defaultSlackOAuthConfig();
  },
  slackOAuthDeps: defaultSlackOAuthDeps,
  // Created on first use, after the environment is loaded; one instance so
  // its login and access caches are shared.
  get githubTeamApi() {
    return (sharedGithubTeamApi ??= createGithubTeamApi());
  },
  slackChannelLookup: createSlackChannelLookup(),
};
