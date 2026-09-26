const { test, expect } = require("@playwright/test");

test.describe("guest and static pages", () => {
  test("home loads with guest pitch and login panel", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#loggedOutView")).toBeVisible();
    await expect(page.locator("#pitchHeadline")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#authPanel")).toBeVisible();
    await expect(page.locator("#emailInput")).toBeVisible();
  });

  test("terms, privacy, pricing, and help pages load", async ({ page }) => {
    await page.goto("/terms.html");
    await expect(page.getByRole("heading", { name: /Terms of Service/i })).toBeVisible();

    await page.goto("/privacy.html");
    await expect(page.getByRole("heading", { name: /Privacy Policy/i })).toBeVisible();

    await page.goto("/pricing.html");
    await expect(page.getByRole("heading", { name: /Pricing/i })).toBeVisible();

    await page.goto("/help.html");
    await expect(page.getByRole("heading", { level: 1, name: "Help" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Photograph a shelf" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Use the library map" })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Support" })).toBeVisible();
    await page.goto("/");
    await expect(page.locator(".auth-legal-links a[href='/help.html']")).toBeVisible();
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

  test("successful signup prompts inbox confirmation and switches to Log In", async ({
    page,
  }) => {
    // Confirmation email is sent by Supabase Auth — mock its signup API only.
    await page.route("**/auth/v1/signup**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          // No session when email confirmation is required.
          access_token: null,
          token_type: "bearer",
          expires_in: null,
          refresh_token: null,
          user: {
            id: "00000000-0000-4000-8000-000000000001",
            email: "newuser@example.com",
            identities: [{ identity_id: "1", provider: "email" }],
          },
        }),
      });
    });

    await page.goto("/");
    await page.locator("#authToggleBtn").click();
    await expect(page.locator("#authActionBtn")).toHaveText("Create Account");

    await page.locator("#emailInput").fill("newuser@example.com");
    await page.locator("#passwordInput").fill("password123");
    await page.locator("#confirmPasswordInput").fill("password123");
    await page.locator("#authTermsCheckbox").check();
    await page.locator("#authActionBtn").click();

    await expect(page.locator(".toast-success .toast-message")).toHaveText(
      /check your inbox to confirm your account/i,
    );
    await expect(page.locator("#authActionBtn")).toHaveText("Log In");
    await expect(page.locator("#authPanelTitle")).toHaveText("Log in");
    await expect(page.locator("#loggedOutView")).toBeVisible();
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

  test("account menu includes details, email, and delete", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#accountDetailsBtn")).toBeAttached();
    await expect(page.locator("#accountEmailBtn")).toBeAttached();
    await expect(page.locator("#accountDeleteBtn")).toBeAttached();
    await expect(page.locator("#accountHelpLink")).toHaveAttribute("href", "/help.html");
    await expect(page.locator("#accountDetailsModal")).toBeAttached();
    await expect(page.locator("#accountEmailModal")).toBeAttached();
    await expect(page.locator("#accountDeleteModal")).toBeAttached();
    await expect(page.locator("#accountDetailsStripeBtn")).toHaveText(/Stripe/i);
    await expect(page.locator("#accountEmailSaveBtn")).toHaveText(/confirmation/i);
  });
});
