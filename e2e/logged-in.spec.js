const { test, expect } = require("@playwright/test");

/**
 * Logged-in smoke tests require E2E_EMAIL and E2E_PASSWORD for a real Supabase user.
 * When unset, these tests are skipped so CI/local can still run guest smoke.
 */
const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);

test.describe("logged-in smoke", () => {
  test.skip(!hasAuth, "Set E2E_EMAIL and E2E_PASSWORD to run authenticated e2e tests");

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator("#emailInput").fill(process.env.E2E_EMAIL);
    await page.locator("#passwordInput").fill(process.env.E2E_PASSWORD);
    // Ensure login mode (not signup)
    const toggle = page.locator("#authToggleBtn");
    const toggleText = await page.locator("#authToggleText").textContent();
    if (toggleText && /already have an account/i.test(toggleText)) {
      await toggle.click();
    }
    await page.locator("#authActionBtn").click();

    // Legal accept modal if present
    const legalModal = page.locator("#legalAcceptModal");
    if (await legalModal.isVisible().catch(() => false)) {
      const hidden = await legalModal.evaluate((el) => el.classList.contains("hidden-view"));
      if (!hidden) {
        await page.locator("#legalAcceptCheckbox").check();
        await page.locator("#legalAcceptConfirmBtn").click();
      }
    }

    await expect(page.locator("#loggedInView")).toBeVisible({ timeout: 30_000 });
  });

  test("scan view exposes dropzone and file input", async ({ page }) => {
    await expect(page.locator("#canvasDropzone")).toBeVisible();
    await expect(page.locator("#imageUpload")).toBeAttached();
    await expect(page.locator("#placeholderText")).toBeVisible();

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator(".dropzone-cta-btn").click(),
    ]);
    expect(fileChooser.isMultiple()).toBeTruthy();
  });

  test("library map navigation works", async ({ page }) => {
    await page.locator("#navLibraryBtn").click();
    await expect(page.locator("#libraryView")).toBeVisible();
    await expect(
      page.locator("#infiniteMap, #libraryEmptyState, .map-viewport").first(),
    ).toBeVisible();
  });

  test("account menu shows plan badge and billing controls", async ({ page }) => {
    await page.locator("#accountMenuBtn").click();
    await expect(page.locator("#accountMenu")).toBeVisible();
    await expect(page.locator("#planBadge")).toBeVisible();
    await expect(
      page.locator("#upgradeBtn, #manageBillingBtn").first(),
    ).toBeVisible();
  });
});
