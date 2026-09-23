const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");
const {
  getPublicAppOrigin,
} = require("../src/public-config");
const {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_VERSION,
} = require("../src/legal");
const {
  readBillingStatusFromUser,
  getPlanFromSubscriptionStatus,
  normalizeInterval,
} = require("../src/billing");
const { PLAN_QUOTAS } = require("../src/http-security");

describe("getPublicAppOrigin", () => {
  it("prefers CANONICAL_ORIGIN over APP_BASE_URL", () => {
    assert.equal(
      getPublicAppOrigin({
        CANONICAL_ORIGIN: "https://shelfmapper.com/",
        APP_BASE_URL: "http://localhost:3000",
      }),
      "https://shelfmapper.com",
    );
  });

  it("falls back to APP_BASE_URL", () => {
    assert.equal(
      getPublicAppOrigin({ APP_BASE_URL: "http://localhost:3000" }),
      "http://localhost:3000",
    );
  });

  it("returns empty string for invalid values", () => {
    assert.equal(getPublicAppOrigin({ APP_BASE_URL: "not-a-url" }), "");
    assert.equal(getPublicAppOrigin({}), "");
  });
});

describe("legal version sync", () => {
  it("exports matching current version ids", () => {
    assert.match(CURRENT_TERMS_VERSION, /^\d{4}\.\d{2}\.\d{2}/);
    assert.equal(CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION);
  });

  it("matches client legal.js constants", () => {
    const clientLegal = fs.readFileSync(
      path.join(__dirname, "../../client/src/js/legal.js"),
      "utf8",
    );
    assert.match(
      clientLegal,
      new RegExp(`CURRENT_TERMS_VERSION = "${CURRENT_TERMS_VERSION}"`),
    );
    assert.match(
      clientLegal,
      new RegExp(`CURRENT_PRIVACY_VERSION = "${CURRENT_PRIVACY_VERSION}"`),
    );
  });

  it("matches terms.html and privacy.html version meta", () => {
    const terms = fs.readFileSync(
      path.join(__dirname, "../../client/src/terms.html"),
      "utf8",
    );
    const privacy = fs.readFileSync(
      path.join(__dirname, "../../client/src/privacy.html"),
      "utf8",
    );
    assert.match(terms, new RegExp(`>${CURRENT_TERMS_VERSION}<`));
    assert.match(privacy, new RegExp(`>${CURRENT_PRIVACY_VERSION}<`));
  });
});

describe("readBillingStatusFromUser", () => {
  it("passes through renewal_notice", () => {
    const notice = {
      amountDueCents: 500,
      currency: "USD",
      renewAt: "2026-10-01T00:00:00.000Z",
    };
    const status = readBillingStatusFromUser(
      {
        app_metadata: {
          plan: "premium",
          stripe_subscription_id: "sub_1",
          stripe_subscription_status: "active",
          stripe_price_id: "price_month",
          renewal_notice: notice,
        },
      },
      PLAN_QUOTAS,
    );
    assert.equal(status.plan, "premium");
    assert.deepEqual(status.renewalNotice, notice);
  });

  it("defaults free plan quotas", () => {
    const status = readBillingStatusFromUser({}, PLAN_QUOTAS);
    assert.equal(status.plan, "free");
    assert.equal(status.quotas.ocr, PLAN_QUOTAS.free.ocr);
  });
});

describe("billing helpers remain stable", () => {
  it("maps subscription statuses", () => {
    assert.equal(getPlanFromSubscriptionStatus("trialing"), "premium");
    assert.equal(getPlanFromSubscriptionStatus("canceled"), "free");
  });

  it("normalizes intervals", () => {
    assert.equal(normalizeInterval("month"), "month");
    assert.equal(normalizeInterval("weekly"), null);
  });
});

describe("photo source chooser markup", () => {
  it("keeps library upload free of capture and camera input capture-only", () => {
    const indexHtml = fs.readFileSync(
      path.join(__dirname, "../../client/src/index.html"),
      "utf8",
    );
    const appJs = fs.readFileSync(
      path.join(__dirname, "../../client/src/js/app.js"),
      "utf8",
    );

    assert.match(
      indexHtml,
      /id="imageUpload"[^>]*accept="image\/\*"[^>]*class="visually-hidden-input"[^>]*multiple/,
    );
    assert.doesNotMatch(
      indexHtml,
      /id="imageUpload"[^>]*capture=/,
    );
    assert.match(
      indexHtml,
      /id="imageCapture"[^>]*accept="image\/\*"[^>]*capture="environment"/,
    );
    assert.match(indexHtml, /id="photoSourceModal"/);
    assert.match(indexHtml, /id="photoSourceCameraBtn"/);
    assert.match(indexHtml, /id="photoSourceLibraryBtn"/);
    assert.match(appJs, /function openPhotoSourceChooser\(/);
    assert.match(appJs, /function isMobilePhotoSourceLayout\(/);
    assert.match(appJs, /max-width:\s*768px/);
    assert.match(appJs, /activateUpload = \(\) => openPhotoSourceChooser\(\)/);
  });
});
