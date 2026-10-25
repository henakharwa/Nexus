import { expect, test } from "@playwright/test";
import { closeBrowserPages, createWorkspace, joinWorkspace, proposeAction, setRole, signUp, userIdFor, waitForChat } from "./helpers";

test.afterEach(closeBrowserPages);

test.describe("approval rules", () => {
  test("an Admin adds a two-approver rule, and the card needs two people other than the requester", async ({ browser }) => {
    // Three people in three browsers.
    test.setTimeout(150_000);
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    const bob = await signUp(browser, "Bob");
    await joinWorkspace(bob, workspace.joinCode, workspace.name);
    const carol = await signUp(browser, "Carol");
    await joinWorkspace(carol, workspace.joinCode, workspace.name);

    // Alice creates the rule on the Approvals page.
    await alice.page.goto(`/w/${workspace.id}/approvals`);
    await expect(alice.page.getByText("No rules yet")).toBeVisible();
    await alice.page.getByLabel("Rule name").fill("Two approvers for GitHub");
    await alice.page.getByLabel("Tool").selectOption("github");
    await alice.page.getByLabel("Approvals needed").selectOption("2");
    await expect(alice.page.getByTestId("approval-rule-summary")).toHaveText(
      "GitHub: any action needs 2 approvals from people other than the requester.",
    );
    await alice.page.getByRole("button", { name: "Create rule" }).click();
    await expect(alice.page.getByTestId("approval-rule-card")).toContainText("Two approvers for GitHub");

    // Bob is an Editor: he can see the rule but not change it.
    await bob.page.goto(`/w/${workspace.id}/approvals`);
    await expect(bob.page.getByTestId("approval-rule-card")).toContainText("Two approvers for GitHub");
    await expect(bob.page.getByRole("button", { name: "Create rule" })).toBeDisabled();
    await expect(bob.page.getByText("Only Admins can change approval rules.")).toBeVisible();

    // Everyone can approve; Bob asks for the change.
    const bobId = await userIdFor(bob.page);
    await setRole(workspace.id, bobId, "admin");
    await setRole(workspace.id, await userIdFor(carol.page), "admin");
    await proposeAction(workspace.id, { id: bobId, name: bob.name }, "Open an issue: flaky login test", {
      name: "Two approvers for GitHub",
      requiredApprovals: 2,
    });
    for (const { page } of [alice, bob, carol]) {
      await page.goto(`/w/${workspace.id}`);
      await waitForChat(page);
      await expect(page.getByTestId("pending-action-rule")).toContainText("Two approvers for GitHub · 0 of 2 approvals");
    }

    // Every card says when it expires. A rule governs this one, so no
    // standing approval can be given from it.
    await expect(alice.page.getByTestId("pending-action-expires")).toContainText(/Expires in 2[34] h/);
    await expect(alice.page.getByTestId("remember-approval")).toHaveCount(0);

    // The requester can't approve his own request.
    await expect(bob.page.getByTestId("confirm-action-btn")).toBeDisabled();
    await expect(bob.page.getByTestId("pending-action-card")).toContainText("someone else has to approve it");

    // First approval: the card stays, for everyone, with the count updated.
    await alice.page.getByTestId("confirm-action-btn").click();
    for (const { page } of [alice, bob, carol]) {
      await expect(page.getByTestId("pending-action-rule")).toContainText(`1 of 2 approvals · approved by ${alice.name}`);
    }
    await expect(alice.page.getByTestId("confirm-action-btn")).toBeDisabled();
    await expect(alice.page.getByTestId("pending-action-card")).toContainText("You approved this.");
    await expect(
      alice.page.getByTestId("chat-message").filter({ hasText: `${alice.name} approved (1 of 2 under rule “Two approvers for GitHub”)` }),
    ).toBeVisible();

    // Bob's connection isn't available (the test has no real GitHub), so the
    // last approver is offered "Run as me" -- earlier approvers never are.
    // Carol has no connection either, so the run fails visibly, which proves
    // her approval completed the set and the action ran.
    await carol.page.getByTestId("run-as-me-btn").click();
    for (const { page } of [alice, bob, carol]) {
      await expect(page.getByTestId("pending-action-card")).toHaveCount(0);
    }
    await expect(carol.page.getByTestId("chat-message").filter({ hasText: "no longer connected" })).toBeVisible();
  });

  test("a new workspace adds the recommended rules in one click, with a warning when the team is too small", async ({
    browser,
  }) => {
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    await alice.page.goto(`/w/${workspace.id}/approvals`);
    await alice.page.getByRole("button", { name: "Add recommended rules" }).click();
    await expect(alice.page.getByTestId("approval-rule-card")).toHaveCount(3);
    await expect(alice.page.getByTestId("approval-rule-card").nth(1)).toContainText(
      "Production changes need a second person",
    );
    // Alice is the only person who can approve, so a rule needing one
    // approver other than the requester can't be met when she asks.
    await expect(alice.page.getByTestId("approval-rule-warning")).toContainText(
      "Only 1 person can approve actions here, so when they ask, nobody else can approve it.",
    );
    await expect(alice.page.getByTestId("standing-approvals")).toContainText("None right now.");

    // A card no rule governs offers "approve similar actions for 7 days".
    await proposeAction(workspace.id, { id: await userIdFor(alice.page), name: alice.name }, "Open an issue: typo in README");
    await alice.page.goto(`/w/${workspace.id}`);
    await waitForChat(alice.page);
    await expect(alice.page.getByTestId("remember-approval")).toBeVisible();
  });
});
