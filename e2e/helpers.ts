import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";

export const API_URL = "http://localhost:4910";

export type Person = { name: string; email: string; password: string; page: Page };

// Every browser window a test opens, so each test can close its own when it
// ends instead of leaving them running (and polling) into the next test.
const openContexts = new Set<BrowserContext>();

/** Opens a separate browser window, like a different person on another computer. */
export async function newBrowserPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  openContexts.add(context);
  return context.newPage();
}

/** Closes every window opened through these helpers. Each spec runs it after each test. */
export async function closeBrowserPages(): Promise<void> {
  await Promise.all([...openContexts].map((context) => context.close().catch(() => undefined)));
  openContexts.clear();
}

/** Signs a brand-new person up through the real sign-up form, in their own browser. */
export async function signUp(browser: Browser, firstName: string): Promise<Person> {
  const page = await newBrowserPage(browser);
  const unique = randomUUID().slice(0, 8);
  const person = { name: `${firstName} ${unique}`, email: `${firstName.toLowerCase()}-${unique}@example.test`, password: `Pass-${randomUUID()}`, page };
  await page.goto("/");
  await page.getByTestId("sign-up-btn").click();
  await page.locator("#auth-name").fill(person.name);
  await page.locator("#auth-email").fill(person.email);
  await page.locator("#auth-password").fill(person.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("workspace-name-input")).toBeVisible();
  return person;
}

/** Creates a workspace from the home page and returns its id once the room is open. */
export async function createWorkspace(person: Person, name = `Team ${randomUUID().slice(0, 6)}`): Promise<{ id: string; name: string; joinCode: string }> {
  await person.page.getByTestId("workspace-name-input").fill(name);
  await person.page.getByTestId("create-workspace-btn").click();
  await person.page.waitForURL(/\/w\/[0-9a-f-]{36}/);
  const id = person.page.url().match(/\/w\/([0-9a-f-]{36})/)![1];
  await expect(person.page.getByRole("heading", { level: 1, name })).toBeVisible();
  const workspace = await (await person.page.request.get(`${API_URL}/workspaces/${id}`)).json();
  return { id, name, joinCode: workspace.joinCode };
}

/** Joins a workspace with its join code from the home page. */
export async function joinWorkspace(person: Person, joinCode: string, workspaceName: string): Promise<void> {
  await person.page.goto("/");
  await person.page.getByTestId("join-code-input").fill(joinCode);
  await person.page.getByTestId("join-workspace-btn").click();
  await person.page.waitForURL(/\/w\/[0-9a-f-]{36}/);
  await expect(person.page.getByRole("heading", { level: 1, name: workspaceName })).toBeVisible();
}

/** Waits until the live chat connection is open (the composer is enabled). */
export async function waitForChat(page: Page): Promise<void> {
  await expect(page.getByTestId("chat-input")).toBeEnabled();
}

export async function sendChat(page: Page, text: string): Promise<void> {
  await waitForChat(page);
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("send-btn").click();
}

/** Direct database access for setting up states the UI can't create alone. */
export async function withDatabase<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates a pending write action the way the agent does when it proposes
 * one. A real proposal needs a connected GitHub or Slack account and a model
 * that chooses to call a write tool, which a test run doesn't have.
 */
export async function proposeAction(
  workspaceId: string,
  requester: { id: string; name: string },
  description: string,
  // What an approval rule decided, the way the server stores it when the agent proposes.
  rule?: { name: string; requiredApprovals: number },
): Promise<string> {
  return withDatabase(async (client) => {
    const conversation = await client.query(`SELECT id FROM conversations WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1`, [workspaceId]);
    const created = await client.query(
      `INSERT INTO pending_actions (workspace_id, conversation_id, tool_name, description, preview, args, requested_by_user_id, requested_by_name, agent_kind, run_as_user_id, required_approvals, approval_rule_name, approval_rule_id)
       VALUES ($1, $2, 'create_issue', $3, $4, '{}'::jsonb, $5, $6, 'github', $5, $7, $8, $9) RETURNING id`,
      [workspaceId, conversation.rows[0].id, description, `Title: ${description}`, requester.id, requester.name, rule?.requiredApprovals ?? 1, rule?.name ?? null, rule ? randomUUID() : null],
    );
    return created.rows[0].id as string;
  });
}

/** Changes a member's workspace role directly (there is no invite-as-Admin through a join code). */
export async function setRole(workspaceId: string, userId: string, role: "admin" | "editor"): Promise<void> {
  await withDatabase((client) => client.query("UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId, role]));
}

export async function userIdFor(page: Page): Promise<string> {
  return (await (await page.request.get(`${API_URL}/auth/me`)).json()).id;
}
