const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createMockSupabase } = require("./helpers/app-harness");
const { createSignupNotify } = require("../src/signup-notify");

describe("signup notify", () => {
  it("sends immediate mail only on ack, not auth sync", async () => {
    const sent = [];
    const mail = {
      async sendEmail(payload) {
        sent.push(payload);
        return { ok: true };
      },
    };
    const user = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "new@example.com",
      created_at: new Date().toISOString(),
      app_metadata: { provider: "email" },
    };
    const supabase = createMockSupabase({
      usersByToken: { t: user },
      tables: {
        admin_settings: [{ key: "signup_notify_mode", value: { mode: "immediate" } }],
        signup_events: [],
      },
    });
    const notify = createSignupNotify({ supabase, mail });

    const synced = await notify.recordSignup(user, { source: "sync" });
    assert.equal(synced.created, true);
    assert.equal(sent.length, 0);

    const again = await notify.recordSignup(user, { source: "ack" });
    assert.equal(again.created, false);
    assert.equal(sent.length, 0);

    const fresh = {
      ...user,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      email: "fresh@example.com",
    };
    const acked = await notify.ackCurrentUser(fresh);
    assert.equal(acked.created, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /fresh@example.com/);
  });

  it("respects off mode", async () => {
    const sent = [];
    const user = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      email: "off@example.com",
      created_at: new Date().toISOString(),
    };
    const supabase = createMockSupabase({
      tables: {
        admin_settings: [{ key: "signup_notify_mode", value: { mode: "off" } }],
        signup_events: [],
      },
    });
    const notify = createSignupNotify({
      supabase,
      mail: {
        async sendEmail(payload) {
          sent.push(payload);
          return { ok: true };
        },
      },
    });
    await notify.ackCurrentUser(user);
    assert.equal(sent.length, 0);
  });
});
