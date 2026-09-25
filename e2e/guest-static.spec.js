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

    // App toast, not the browser required bubble — still on signup panel
    await expect(page.locator("#authPanel")).toBeVisible();
    await expect(page.locator("#authTermsCheckbox")).not.toBeChecked();
    await expect(page.locator(".toast-error .toast-message")).toHaveText(
      /agree to the Terms of Service and Privacy Policy/i,
    );
  });

  test("invalid share token page does not crash", async ({ page }) => {
    await page.goto("/share/invalid-token-xyz");
    // Client should render something without a hard error overlay
    await expect(page.locator("body")).toBeVisible();
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test("photo upload separates camera capture from library picker", async ({ page }) => {
    await page.goto("/");

    const libraryInput = page.locator("#imageUpload");
    const cameraInput = page.locator("#imageCapture");
    await expect(libraryInput).toBeAttached();
    await expect(cameraInput).toBeAttached();
    await expect(libraryInput).not.toHaveAttribute("capture");
    await expect(cameraInput).toHaveAttribute("capture", "environment");
    await expect(libraryInput).toHaveAttribute("accept", "image/*");
    await expect(cameraInput).toHaveAttribute("accept", "image/*");

    await expect(page.locator("#photoSourceModal")).toBeAttached();
    await expect(page.locator("#photoSourceCameraBtn")).toHaveText(/Take photo/i);
    await expect(page.locator("#photoSourceLibraryBtn")).toHaveText(/Choose from library/i);
    await expect(page.locator("#photoSourceCancelBtn")).toBeAttached();
  });
});
