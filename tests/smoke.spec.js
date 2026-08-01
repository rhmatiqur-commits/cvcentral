// CV Central — critical-path smoke tests.
//
// Why these tests exist: in one working session, six production bugs shipped
// and were only caught by a human manually clicking around (Upgrade button
// showing for Pro users, subscription cancel panel hidden, CV parsing
// dropping fields, saved CVs vanishing, "Open" landing on the wrong wizard
// step, and "Analyse my CV" 502ing for CVs with several jobs). This suite
// covers the paths where regressions actually happened, so the next one
// gets caught by `npm test` instead of a user.
//
// Run with: npm test  (see TESTING.md for setup and env vars)

const { test, expect } = require('@playwright/test');

const hasTestUser = !!(process.env.TEST_USER_EMAIL && process.env.TEST_USER_PASSWORD);

test.describe('Public pages', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/CV Central/i);
  });

  test('signup page loads with the signup form', async ({ page }) => {
    await page.goto('/signup.html');
    await expect(page.locator('#signupForm')).toBeVisible();
    await expect(page.locator('#fullName')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
  });

  test('login page loads with the login form', async ({ page }) => {
    await page.goto('/login.html');
    await expect(page.locator('#loginForm')).toBeVisible();
  });
});

test.describe('Security regression — /api/ai and /api/chat must reject unauthenticated requests', () => {
  // Regression test for the fix shipped 2026-08-01: these endpoints used to
  // trust a client-supplied "plan" field with no auth check at all, meaning
  // anyone could script free Sonnet-tier requests. If this test ever starts
  // failing (200 instead of 401), that hole is back.
  test('/api/ai rejects a request with no Authorization header', async ({ request }) => {
    const res = await request.post('/api/ai?action=enhance', {
      data: { plan: 'pro', personal: { fullName: 'Smoke Test' } }
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('/api/chat rejects a request with no Authorization header', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { messages: [{ role: 'user', content: 'hi' }] }
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('Guest CV builder flow', () => {
  test('a guest can fill in step 1 and click through to the review step', async ({ page }) => {
    await page.goto('/cv-builder.html');

    await page.locator('#fullName').fill('Smoke Test User');
    await page.locator('#email').fill('smoke-test@example.com');
    await page.locator('#targetRole').fill('QA Engineer');

    // Steps 2-4 have no required fields — click through without filling
    // anything, matching the most common guest path (skip straight to AI).
    for (let i = 0; i < 4; i++) {
      await page.locator('[data-next]:visible').first().click();
    }

    // Should now be on step 5 (review/AI step), not stuck on step 1.
    await expect(page.locator('.wizard-step[data-step="5"]')).toHaveClass(/active/);
  });
});

test.describe('Authenticated flow', () => {
  test.skip(!hasTestUser, 'Set TEST_USER_EMAIL and TEST_USER_PASSWORD to run authenticated tests — see TESTING.md');

  test('save a CV, then reopen it from the dashboard and land on the finished CV (not step 1)', async ({ page }) => {
    // ---- Log in ----
    await page.goto('/login.html');
    await page.locator('#email').fill(process.env.TEST_USER_EMAIL);
    await page.locator('#password').fill(process.env.TEST_USER_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL(/dashboard\.html/, { timeout: 15000 });

    // ---- Build a minimal CV ----
    await page.goto('/cv-builder.html');
    const uniqueName = 'Smoke Test ' + Date.now();
    await page.locator('#fullName').fill(uniqueName);
    await page.locator('#email').fill('smoke-test@example.com');
    await page.locator('#targetRole').fill('QA Engineer');
    for (let i = 0; i < 4; i++) {
      await page.locator('[data-next]:visible').first().click();
    }
    await expect(page.locator('.wizard-step[data-step="5"]')).toHaveClass(/active/);

    // ---- Save (no AI call needed for this regression test — we're testing
    // the save/reopen path, not AI quality, and skipping the AI call keeps
    // this test free to run as often as needed) ----
    await page.locator('#saveBtn').click();
    await expect(page.getByText('CV saved to your account')).toBeVisible({ timeout: 10000 });

    // ---- Regression check: opening it from the dashboard must show the
    // finished CV, not dump the user back into the step-1 edit wizard
    // (this was the bug fixed 2026-08-01, task #9) ----
    await page.goto('/dashboard.html');
    const cvCard = page.locator('.dash-card', { hasText: uniqueName }).first();
    await expect(cvCard).toBeVisible({ timeout: 10000 });
    await cvCard.getByRole('button', { name: /open/i }).click();

    await page.waitForURL(/cv-builder\.html\?view=1/, { timeout: 10000 });
    await expect(page.locator('.wizard-step[data-step="5"]')).toHaveClass(/active/);
    await expect(page.locator('.wizard-step[data-step="1"]')).not.toHaveClass(/active/);
  });

  test('AI analysis renders results in the UI (mocked response — no real Anthropic call)', async ({ page }) => {
    // Mocking the AI response protects the Anthropic budget: this test runs
    // on every `npm test`, and a real call here would cost money every time
    // without testing anything the unit-level prompt logic doesn't already
    // cover. What we DO want to catch is a UI regression in how the response
    // gets rendered — that's what this test is for.
    await page.route('**/api/ai?action=enhance', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enhanced: { summary: 'Mocked summary.', experience: [] },
          score: { total: 82, breakdown: { formatting: 80, keywords: 78, achievements: 85, ats: 82, length: 85 } },
          recommendedTemplate: 'modern',
          coverLetter: 'Mocked cover letter.',
          atsKeywords: ['testing', 'automation'],
          improvements: ['Mocked improvement 1', 'Mocked improvement 2', 'Mocked improvement 3']
        })
      });
    });

    await page.goto('/login.html');
    await page.locator('#email').fill(process.env.TEST_USER_EMAIL);
    await page.locator('#password').fill(process.env.TEST_USER_PASSWORD);
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL(/dashboard\.html/, { timeout: 15000 });

    await page.goto('/cv-builder.html');
    await page.locator('#fullName').fill('Smoke Test AI');
    await page.locator('#email').fill('smoke-test@example.com');
    await page.locator('#targetRole').fill('QA Engineer');
    for (let i = 0; i < 4; i++) {
      await page.locator('[data-next]:visible').first().click();
    }

    await page.locator('#analyseBtn').click();
    await expect(page.locator('#resultScore')).toHaveText('82', { timeout: 10000 });
  });
});
