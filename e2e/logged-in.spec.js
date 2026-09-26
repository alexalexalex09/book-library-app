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

  test("scan view opens library file picker on desktop without photo chooser", async ({ page }) => {
    await page.locator("#navUploadBtn").click();
    await expect(page.locator("#canvasDropzone")).toBeVisible();
    await expect(page.locator("#imageUpload")).toBeAttached();
    await expect(page.locator("#imageCapture")).toBeAttached();
    await expect(page.locator("#imageUpload")).not.toHaveAttribute("capture");
    await expect(page.locator("#imageCapture")).toHaveAttribute("capture", "environment");
    await expect(page.locator("#placeholderText")).toBeVisible();

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator(".dropzone-cta-btn").click(),
    ]);
    expect(fileChooser.isMultiple()).toBeTruthy();
    await expect(page.locator("#photoSourceModal")).toHaveClass(/hidden-view/);
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
    await expect(page.locator("#accountDetailsBtn")).toBeVisible();
    await expect(page.locator("#accountEmailBtn")).toBeVisible();
    await expect(page.locator("#accountDeleteBtn")).toBeVisible();
    await expect(page.locator("#accountHelpLink")).toBeVisible();
    await expect(page.locator("#accountHelpLink")).toHaveAttribute("href", "/help.html");

    await page.locator("#accountDetailsBtn").click();
    await expect(page.locator("#accountDetailsModal")).toBeVisible();
    await expect(page.locator("#accountStatsList")).toContainText(/Plan/i);
    await expect(page.locator("#accountStatsList")).toContainText(/Scans remaining/i);
    await expect(page.locator("#accountDetailsStripeBtn")).toBeVisible();
    await page.locator("#accountDetailsCloseBtn").click();
    await expect(page.locator("#accountDetailsModal")).toHaveClass(/hidden-view/);

    await page.locator("#accountMenuBtn").click();
    await page.locator("#accountEmailBtn").click();
    await expect(page.locator("#accountEmailModal")).toBeVisible();
    await expect(page.locator("#accountEmailCurrent")).not.toBeEmpty();
    await page.locator("#accountEmailCloseBtn").click();
  });
});

test.describe("logged-in mobile library sheet", () => {
  test.skip(!hasAuth, "Set E2E_EMAIL and E2E_PASSWORD to run authenticated e2e tests");

  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Mobile guest layout hides the auth panel until Log in is opened
    await page.locator("#guestNavLoginBtn").click();
    await expect(page.locator("#emailInput")).toBeVisible();
    await page.locator("#emailInput").fill(process.env.E2E_EMAIL);
    await page.locator("#passwordInput").fill(process.env.E2E_PASSWORD);
    const toggle = page.locator("#authToggleBtn");
    const toggleText = await page.locator("#authToggleText").textContent();
    if (toggleText && /already have an account/i.test(toggleText)) {
      await toggle.click();
    }
    await page.locator("#authActionBtn").click();

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

  test("mobile library toggle expands and collapses the sheet", async ({ page }) => {
    await page.locator("#navLibraryBtn").click();
    await expect(page.locator("#libraryView")).toBeVisible();

    const header = page.locator("#mobileLibraryToggle");
    const content = page.locator("#mobileLibraryContent");
    await expect(header).toBeVisible();

    // Default mobile state is collapsed
    await expect(content).toHaveClass(/collapsed/);
    await expect(header).toHaveAttribute("aria-expanded", "false");

    // Hit target at header center should be the toggle (not the bottom nav)
    const box = await header.boundingBox();
    expect(box).toBeTruthy();
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        if (el.id === "mobileLibraryToggle" || el.closest("#mobileLibraryToggle")) {
          return "mobileLibraryToggle";
        }
        return el.id || el.className || el.tagName;
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit).toBe("mobileLibraryToggle");

    await header.click();
    await expect(content).not.toHaveClass(/collapsed/);
    await expect(header).toHaveAttribute("aria-expanded", "true");

    await header.click();
    await expect(content).toHaveClass(/collapsed/);
    await expect(header).toHaveAttribute("aria-expanded", "false");
  });

  test("mobile scan view offers camera or library photo chooser", async ({ page }) => {
    await page.locator("#navUploadBtn").click();
    await expect(page.locator("#canvasDropzone")).toBeVisible();
    await expect(page.locator("#placeholderText")).toBeVisible();

    await page.locator(".dropzone-cta-btn").click();
    await expect(page.locator("#photoSourceModal")).toBeVisible();
    await expect(page.locator("#photoSourceCameraBtn")).toBeVisible();
    await expect(page.locator("#photoSourceLibraryBtn")).toBeVisible();

    const [libraryChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator("#photoSourceLibraryBtn").click(),
    ]);
    expect(libraryChooser.isMultiple()).toBeTruthy();

    await page.locator("#placeholderText").click();
    await expect(page.locator("#photoSourceModal")).toBeVisible();
    const [cameraChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator("#photoSourceCameraBtn").click(),
    ]);
    expect(cameraChooser.isMultiple()).toBeFalsy();
  });
});

test.describe("logged-in desktop library sheet", () => {
  test.skip(!hasAuth, "Set E2E_EMAIL and E2E_PASSWORD to run authenticated e2e tests");

  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator("#emailInput").fill(process.env.E2E_EMAIL);
    await page.locator("#passwordInput").fill(process.env.E2E_PASSWORD);
    const toggle = page.locator("#authToggleBtn");
    const toggleText = await page.locator("#authToggleText").textContent();
    if (toggleText && /already have an account/i.test(toggleText)) {
      await toggle.click();
    }
    await page.locator("#authActionBtn").click();

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

  test("desktop My Library header toggles the sidebar panel", async ({ page }) => {
    await page.locator("#navLibraryBtn").click();
    await expect(page.locator("#libraryView")).toBeVisible();

    const header = page.locator("#mobileLibraryToggle");
    const content = page.locator("#mobileLibraryContent");
    await expect(header).toBeVisible();

    // Desktop default is expanded
    await expect(content).not.toHaveClass(/collapsed/);
    await expect(header).toHaveAttribute("aria-expanded", "true");

    await header.click();
    await expect(content).toHaveClass(/collapsed/);
    await expect(header).toHaveAttribute("aria-expanded", "false");

    await header.click();
    await expect(content).not.toHaveClass(/collapsed/);
    await expect(header).toHaveAttribute("aria-expanded", "true");
  });
});
