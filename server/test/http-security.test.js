const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const express = require("express");
const {
  MAX_IMAGE_BYTES,
  PLAN_QUOTAS,
  createImageUpload,
  createRequireAuth,
  getUserPlan,
  getBearerToken,
  handleUploadError,
  sniffImageMime,
  setSecurityHeaders,
} = require("../src/http-security");

describe("getBearerToken", () => {
  it("extracts a case-insensitive Bearer token", () => {
    assert.equal(getBearerToken("bearer valid-token"), "valid-token");
  });

  it("rejects malformed authorization headers", () => {
    assert.equal(getBearerToken("Basic credentials"), null);
    assert.equal(getBearerToken("Bearer token with spaces"), null);
    assert.equal(getBearerToken(undefined), null);
  });
});

describe("createRequireAuth", () => {
  it("rejects missing credentials without calling Supabase", async () => {
    let authCalled = false;
    const middleware = createRequireAuth({
      auth: {
        getUser: async () => {
          authCalled = true;
        },
      },
    });
    const response = createResponse();

    await middleware({ get: () => undefined }, response, () => {
      assert.fail("next should not be called");
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: "Authentication required" });
    assert.equal(authCalled, false);
  });

  it("uses the verified Supabase user as the request identity", async () => {
    const verifiedUser = { id: "verified-user" };
    const middleware = createRequireAuth({
      auth: {
        getUser: async (token) => {
          assert.equal(token, "valid-token");
          return { data: { user: verifiedUser }, error: null };
        },
      },
    });
    const request = { get: () => "Bearer valid-token" };
    let nextCalled = false;

    await middleware(request, createResponse(), () => {
      nextCalled = true;
    });

    assert.equal(request.user, verifiedUser);
    assert.equal(nextCalled, true);
  });
});

describe("getUserPlan", () => {
  it("defaults to free when metadata is missing", () => {
    assert.equal(getUserPlan({ id: "u1" }), "free");
  });

  it("uses app_metadata plan for premium users", () => {
    assert.equal(getUserPlan({ app_metadata: { plan: "premium" } }), "premium");
    assert.equal(getUserPlan({ app_metadata: { plan: "PREMIUM" } }), "premium");
  });

  it("ignores user_metadata plan values", () => {
    assert.equal(getUserPlan({ user_metadata: { plan: "premium" } }), "free");
  });
});

describe("sniffImageMime", () => {
  it("detects jpeg/png/webp magic bytes", () => {
    assert.equal(
      sniffImageMime(
        Buffer.from([
          0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00,
        ]),
      ),
      "image/jpeg",
    );
    assert.equal(
      sniffImageMime(
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00,
        ]),
      ),
      "image/png",
    );
    assert.equal(
      sniffImageMime(
        Buffer.from([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50,
        ]),
      ),
      "image/webp",
    );
  });

  it("returns null for unsupported bytes", () => {
    assert.equal(sniffImageMime(Buffer.from("not-an-image")), null);
  });
});

describe("plan quotas", () => {
  it("keeps premium higher than free limits", () => {
    assert.ok(PLAN_QUOTAS.free.ocr > 0);
    assert.ok(PLAN_QUOTAS.premium.ocr > PLAN_QUOTAS.free.ocr);
    assert.ok(PLAN_QUOTAS.premium.books > PLAN_QUOTAS.free.books);
  });
});

describe("image upload restrictions", () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    const upload = createImageUpload();
    app.post("/upload", upload.single("image"), (req, res) => {
      res.json({ mimetype: req.file.mimetype, size: req.file.size });
    });
    app.use(handleUploadError);

    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("accepts supported image types", async () => {
    const form = new FormData();
    form.append("image", new Blob(["image"], { type: "image/png" }), "book.png");

    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: form,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mimetype: "image/png",
      size: 5,
    });
  });

  it("rejects unsupported file types", async () => {
    const form = new FormData();
    form.append("image", new Blob(["text"], { type: "text/plain" }), "book.txt");

    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: form,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Upload must be one JPEG, PNG, or WebP image",
    });
  });

  it("rejects images larger than the configured limit", async () => {
    const form = new FormData();
    form.append(
      "image",
      new Blob([Buffer.alloc(MAX_IMAGE_BYTES + 1)], { type: "image/jpeg" }),
      "large.jpg",
    );

    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: form,
    });

    assert.equal(response.status, 413);
  });
});

describe("setSecurityHeaders", () => {
  it("sets browser hardening headers", () => {
    const headers = {};
    let nextCalled = false;

    setSecurityHeaders(
      {},
      {
        set(values) {
          Object.assign(headers, values);
        },
      },
      () => {
        nextCalled = true;
      },
    );

    assert.match(headers["Content-Security-Policy"], /object-src 'none'/);
    assert.doesNotMatch(headers["Content-Security-Policy"], /unsafe-inline/);
    assert.match(headers["Content-Security-Policy"], /https:\/\/\*\.supabase\.co/);
    assert.match(headers["Content-Security-Policy"], /img-src/);
    assert.equal(
      headers["Strict-Transport-Security"],
      "max-age=31536000; includeSubDomains",
    );
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.equal(nextCalled, true);
  });
});

function createResponse() {
  return {
    body: null,
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}
