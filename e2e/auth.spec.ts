import { expect, test } from "@playwright/test";
import { closeBrowserPages, newBrowserPage, signUp } from "./helpers";

test.afterEach(closeBrowserPages);

test.describe("sign-in", () => {
  test("sign up, sign out and sign back in with email", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const { page } = alice;

    // Signed in: the create/join workspace forms are shown.
    await expect(page.getByTestId("create-workspace-btn")).toBeVisible();

    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page.getByTestId("sign-in-btn")).toBeVisible();

    await page.getByTestId("sign-in-btn").click();
    await page.locator("#auth-email").fill(alice.email);
    await page.locator("#auth-password").fill(alice.password);
    await page.getByRole("dialog").getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByTestId("create-workspace-btn")).toBeVisible();
  });

  test("a wrong password is refused and keeps the person signed out", async ({ browser }) => {
    const bob = await signUp(browser, "Bob");
    const { page } = bob;
    await page.getByRole("button", { name: "Sign Out" }).click();
    await page.getByTestId("sign-in-btn").click();
    await page.locator("#auth-email").fill(bob.email);
    await page.locator("#auth-password").fill("not-the-password");
    await page.getByRole("dialog").getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByText("Invalid email or password.")).toBeVisible();
    await expect(page.getByTestId("create-workspace-btn")).toHaveCount(0);
  });

  test("signing up with an email that already has an account is refused", async ({ browser }) => {
    const carol = await signUp(browser, "Carol");
    const stranger = await newBrowserPage(browser);
    await stranger.goto("/");
    await stranger.getByTestId("sign-up-btn").click();
    await stranger.locator("#auth-name").fill("Mallory");
    await stranger.locator("#auth-email").fill(carol.email);
    await stranger.locator("#auth-password").fill("another-password-123");
    await stranger.getByRole("button", { name: "Create account" }).click();
    await expect(stranger.getByText("Unable to create an account. Check your details and try again.")).toBeVisible();
    await expect(stranger.getByTestId("create-workspace-btn")).toHaveCount(0);
  });
});
