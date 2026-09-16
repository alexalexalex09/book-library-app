const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  getPlanFromSubscriptionStatus,
  normalizeInterval,
} = require("../src/billing");

describe("getPlanFromSubscriptionStatus", () => {
  it("maps trialing and active to premium", () => {
    assert.equal(getPlanFromSubscriptionStatus("trialing"), "premium");
    assert.equal(getPlanFromSubscriptionStatus("active"), "premium");
  });

  it("maps canceled statuses to free", () => {
    assert.equal(getPlanFromSubscriptionStatus("canceled"), "free");
    assert.equal(getPlanFromSubscriptionStatus("past_due"), "free");
    assert.equal(getPlanFromSubscriptionStatus("unpaid"), "free");
  });
});

describe("normalizeInterval", () => {
  it("accepts month and year", () => {
    assert.equal(normalizeInterval("month"), "month");
    assert.equal(normalizeInterval("year"), "year");
  });

  it("rejects invalid intervals", () => {
    assert.equal(normalizeInterval("weekly"), null);
    assert.equal(normalizeInterval(""), null);
  });
});
