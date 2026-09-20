const { test, expect } = require("@playwright/test");

test.describe("guest and static pages", () => {
  test("home loads with guest pitch and login panel", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#loggedOutView")).toBeVisible();
    await expect(page.locator("#pitchHeadline")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#authPanel")).toBeVisible();
    await expect(page.locator("#emailInput")).toBeVisible();
  });

  test("terms, privacy, and pricing pages load", async ({ page }) => {
    await page.goto("/terms.html");
    await expect(page.getByRole("heading", { name: /Terms of Service/i })).toBeVisible();

    await page.goto("/privacy.html");
    await expect(page.getByRole("heading", { name: /Privacy Policy/i })).toBeVisible();

    await page.goto("/pricing.html");
    await expect(page.getByRole("heading", { name: /Pricing/i })).toBeVisible();
  });

  test("signup mode shows terms checkbox and blocks unchecked submit", async ({ page }) => {
    await page.goto("/");
    await page.locator("#authToggleBtn").click();
    await expect(page.locator("#authTermsRow")).toBeVisible();
    await expect(page.locator("#authTermsCheckbox")).toBeVisible();

    await page.locator("#emailInput").fill("newuser@example.com");
    await page.locator("#passwordInput").fill("password123");
    await page.locator("#confirmPasswordInput").fill("password123");
    await page.locator("#authActionBtn").click();

    // Checkbox required — still on signup panel
    await expect(page.locator("#authPanel")).toBeVisible();
    await expect(page.locator("#authTermsCheckbox")).not.toBeChecked();
  });

  test("invalid share token page does not crash", async ({ page }) => {
    await page.goto("/share/invalid-token-xyz");
    // Client should render something without a hard error overlay
    await expect(page.locator("body")).toBeVisible();
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});
