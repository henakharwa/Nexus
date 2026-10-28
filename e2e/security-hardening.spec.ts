// Security Validation scopes 11 and 12 in a real browser: the strict
// Content-Security-Policy must not break any screen, memory changes from an
// Editor wait for an Admin, task changes reach the activity log, and the
// activity CSV export neutralises spreadsheet formulas.
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { API_URL, closeBrowserPages, createWorkspace, joinWorkspace, signUp, userIdFor, withDatabase } from "./helpers";

test.afterEach(closeBrowserPages);

/** Collects every CSP violation the page reports, from the DOM event and the console. */
function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to (execute|load|apply|connect)/i.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (/Content Security Policy/i.test(error.message)) violations.push(error.message);
  });
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}

test.describe("security hardening (scopes 11 and 12)", () => {
  test("every workspace screen renders under the nonce CSP with the security headers", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const violations = watchCsp(alice.page);
    const workspace = await createWorkspace(alice);

    const response = await alice.page.goto(`/w/${workspace.id}`);
    const headers = response!.headers();
    expect(headers["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-powered-by"]).toBeUndefined();
    // Each response gets its own nonce.
    const again = (await alice.page.request.get(`/w/${workspace.id}`)).headers()["content-security-policy"];
    expect(again).not.toBe(headers["content-security-policy"]);

    for (const path of ["", "/overview", "/memory", "/tasks", "/audit", "/agents", "/workflows", "/artifacts", "/integrations", "/notifications", "/observability", "/approvals"]) {
      await alice.page.goto(`/w/${workspace.id}${path}`);
      // Client-side data loads (fetch to the API) must not be blocked either.
      await alice.page.waitForLoadState("networkidle");
    }
    for (const path of ["/", "/privacy", "/terms", "/reset-password?token=x", "/shared/00000000-0000-4000-8000-000000000000"]) {
      await alice.page.goto(path);
      await alice.page.waitForLoadState("networkidle");
    }
    expect(violations).toEqual([]);

    const api = await alice.page.request.get(`${API_URL}/healthz`);
    expect(api.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(api.headers()["x-frame-options"]).toBe("DENY");
  });

  test("an Editor's memory change waits for an Admin before agents can use it", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    const bob = await signUp(browser, "Bob");
    await joinWorkspace(bob, workspace.joinCode, workspace.name);
    const title = `Deploy window ${Date.now()}`;

    await bob.page.goto(`/w/${workspace.id}/memory`);
    await bob.page.getByLabel(/^Title/).fill(title);
    await bob.page.getByLabel(/What the team should know/).fill("Deploy on Tuesdays at 10am.");
    await bob.page.getByRole("button", { name: "Continue" }).click();
    await bob.page.getByRole("button", { name: "Continue" }).click();
    await bob.page.getByRole("button", { name: "Submit for review" }).click();
    await expect(bob.page.getByText("Sent to an Admin for review")).toBeVisible();
    await expect(bob.page.getByRole("heading", { name: "Your proposed changes" })).toBeVisible();
    // Not live yet.
    const before = await (await bob.page.request.get(`${API_URL}/workspaces/${workspace.id}/memory`)).json();
    expect(before.some((entry: { title: string }) => entry.title === title)).toBe(false);

    await alice.page.goto(`/w/${workspace.id}/memory`);
    const queue = alice.page.getByRole("region", { name: "Memory changes waiting for review" });
    await expect(queue.getByRole("heading", { name: "Changes to review" })).toBeVisible();
    await expect(queue).toContainText(title);
    await expect(queue).toContainText("Deploy on Tuesdays at 10am.");
    await queue.getByRole("button", { name: "Approve" }).click();
    await expect(alice.page.getByText("Change approved")).toBeVisible();
    await expect(alice.page.locator(".memory-card", { hasText: title })).toBeVisible();

    await bob.page.reload();
    await expect(bob.page.locator(".memory-card", { hasText: title })).toBeVisible();
  });

  test("task changes appear in Activity and the CSV export neutralises formulas", async ({ browser }) => {
    const mallory = await signUp(browser, "Mallory");
    const workspace = await createWorkspace(mallory);
    // A display name that a spreadsheet would run as a formula.
    const malloryId = await userIdFor(mallory.page);
    await withDatabase((client) => client.query("UPDATE users SET display_name='=HYPERLINK(1)' WHERE id=$1", [malloryId]));
    const created = await mallory.page.request.post(`${API_URL}/workspaces/${workspace.id}/tasks`, {
      data: { title: "Audit me" },
      headers: { origin: new URL(mallory.page.url()).origin },
    });
    expect(created.status()).toBe(201);
    const task = await created.json();
    await mallory.page.request.patch(`${API_URL}/workspaces/${workspace.id}/tasks/${task.id}`, {
      data: { status: "done" },
      headers: { origin: new URL(mallory.page.url()).origin },
    });

    await mallory.page.goto(`/w/${workspace.id}/audit`);
    await expect(mallory.page.getByText(/created task Audit me/).first()).toBeVisible();
    await expect(mallory.page.getByText(/moved it from To do to Done/).first()).toBeVisible();

    const [download] = await Promise.all([
      mallory.page.waitForEvent("download"),
      mallory.page.getByRole("button", { name: "Export CSV" }).click(),
    ]);
    const csv = await readFile((await download.path())!, "utf8");
    expect(csv).toContain(`"'=HYPERLINK(1)`);
    expect(csv).not.toMatch(/(^|,)"=HYPERLINK/m);
  });
});
