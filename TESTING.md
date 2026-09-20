# Testing

## Server tests

```bash
npm run test:server
# or
npm test --prefix server
```

Uses Node's built-in test runner (`node --test`). Coverage includes unit helpers and API integration tests with mocked Supabase/Stripe/Vision.

## End-to-end (Playwright)

```bash
npm install
npm run test:e2e:install   # once: download Chromium
npm run test:e2e
```

Guest/static smoke tests run without credentials.

Authenticated smoke tests require:

```bash
set E2E_EMAIL=your-test-user@example.com
set E2E_PASSWORD=your-test-password
npm run test:e2e
```

Optional: `E2E_PORT` (default `3100`) if port 3100 is busy.

## Full suite

```bash
npm test
```

Runs server tests, then Playwright.
