# Smoke tests

Playwright tests covering the paths that actually broke in production this
session: opening a saved CV landing on the wrong step, AI analysis 502ing,
and the unauthenticated-AI-endpoint security hole. Run these after any
change that touches auth, the CV builder wizard, or the AI endpoints.

## Setup (one-time)

```
npm install
npx playwright install --with-deps chromium
```

## Running the public/security tests (no setup needed)

```
npm test
```

This covers: homepage/signup/login load correctly, the guest CV-builder
wizard can be filled in and clicked through to the review step, and
`/api/ai` + `/api/chat` correctly reject requests with no Authorization
header (401).

## Running the authenticated tests (save/reopen CV, AI results rendering)

These need one dedicated, already-confirmed CV Central test account — don't
use your own or a real user's. Create it once via the normal signup flow at
cvcentral.io/signup.html and confirm the email, then run:

```
TEST_USER_EMAIL="your-test-account@example.com" TEST_USER_PASSWORD="..." npm test
```

Without these env vars set, the authenticated tests are skipped (not
failed) — `npm test` still runs the rest.

## What's NOT covered

- Real Anthropic API calls. The AI-analysis test mocks the `/api/ai`
  response via `page.route` — it checks that the UI renders a result
  correctly, not that the AI itself produces good output. That's a
  judgment call, not something a smoke test can assert on.
- Payments/Stripe checkout. Not exercised by any test — there's no safe way
  to test a real charge automatically, and Stripe's test mode would need
  separate test API keys wired into a non-production environment we don't
  have yet.
- These run against production (`https://cvcentral.io`) by default, since
  there's no staging deployment. Override with `BASE_URL=...` if that
  changes. The authenticated tests write a real CV to the test account
  each run — expect a small amount of test data to accumulate there over
  time; periodically clean it out from admin.html or the account itself.

## Adding a new test

Add it to `tests/smoke.spec.js` only if it covers something that has
actually broken before, or something high-risk that would be embarrassing
to ship broken (auth, payments, data loss). Resist the urge to test
everything — a slow, flaky suite that nobody runs is worse than a small
one that always passes cleanly.
