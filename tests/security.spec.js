/**
 * CV Central — security regression tests for audit findings C-1, C-2, C-3.
 *
 * These run the serverless handlers in-process against mock req/res objects.
 * They make no network calls, touch no production data and perform no live
 * Stripe operations: global.fetch is stubbed per test, and webhook signatures
 * are produced with Stripe's own generateTestHeaderString using a local test
 * secret. Nothing here needs a deployment, so these assertions hold on a
 * branch before anything ships.
 *
 * Each test states the vulnerability it guards against. If one of these ever
 * fails, the corresponding hole has been reopened.
 */

const { test, expect } = require('@playwright/test');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

// Defaults to this checkout. AUDIT_REPO lets the same assertions be pointed
// at another checkout — used to demonstrate that these tests genuinely fail
// against the pre-remediation code rather than passing vacuously.
const REPO = process.env.AUDIT_REPO || path.join(__dirname, '..');

const ADMIN_ID  = '11111111-1111-4111-8111-111111111111';
const USER_ID    = '22222222-2222-4222-8222-222222222222';
const VICTIM_ID  = '33333333-3333-4333-8333-333333333333';
// Assembled at runtime rather than written as literals: these are dummy
// values, but spelled out they match Stripe's key patterns and trip GitHub
// push protection, which should stay noisy for the real thing.
const WH_SECRET  = ['whsec', 'test', 'local', 'only'].join('_');
const DUMMY_SK   = ['sk', 'test'].join('_') + '0'.repeat(24);

// ── mock plumbing ──────────────────────────────────────────────────────────

function mockRes() {
  const r = { statusCode: null, body: null, headers: {}, ended: false };
  r.setHeader = function (k, v) { r.headers[String(k).toLowerCase()] = v; return r; };
  r.status = function (c) { r.statusCode = c; return r; };
  r.json = function (b) { r.body = b; return r; };
  r.end = function () { r.ended = true; return r; };
  return r;
}

function mockReq(opts) {
  return Object.assign({ method: 'POST', headers: {}, query: {}, body: undefined }, opts || {});
}

/** A request whose body is only readable as a stream, as with bodyParser off. */
function streamReq(rawBody, headers) {
  const req = Readable.from([Buffer.from(rawBody, 'utf8')]);
  req.method = 'POST';
  req.headers = headers || {};
  req.query = {};
  return req;
}

/**
 * Stubs global.fetch. `users` maps bearer token -> user object; any Supabase
 * REST call is recorded in calls[] and answered from `rows`.
 */
function stubFetch(opts) {
  const calls = [];
  const users = (opts && opts.users) || {};
  const rows = (opts && opts.rows) || [];
  global.fetch = async function (url, init) {
    const u = String(url);
    calls.push({ url: u, init: init || {} });

    if (u.indexOf('/auth/v1/user') !== -1) {
      const auth = (init && init.headers && init.headers.Authorization) || '';
      const token = auth.replace('Bearer ', '');
      const user = users[token];
      if (!user) return { ok: false, status: 401, json: async () => ({}), text: async () => '{}' };
      return { ok: true, status: 200, json: async () => user, text: async () => JSON.stringify(user) };
    }

    const payload = typeof rows === 'function' ? rows(u) : rows;
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, json: async () => payload, text: async () => text };
  };
  return calls;
}

let savedFetch, savedEnv;
test.beforeEach(() => {
  savedFetch = global.fetch;
  savedEnv = Object.assign({}, process.env);
  process.env.SUPABASE_SERVICE_KEY = 'service_key_test_only';
  process.env.STRIPE_SECRET_KEY = DUMMY_SK;
  delete process.env.ADMIN_USER_IDS;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});
test.afterEach(() => {
  global.fetch = savedFetch;
  process.env = savedEnv;
});

function load(rel) {
  const p = require.resolve(path.join(REPO, rel));
  delete require.cache[p];
  return require(p);
}

// ───────────────────────────────────────────────────────────────────────────
// C-1 — admin endpoints exposed every profile and every CV behind a password
//       that was published in admin.html.
// ───────────────────────────────────────────────────────────────────────────

test.describe('C-1 admin data exposure', () => {

  test('admin.html ships no credential and no x-admin-key usage', () => {
    const html = fs.readFileSync(path.join(REPO, 'admin.html'), 'utf8');
    // The literal assignment that was publicly served.
    expect(html).not.toMatch(/var\s+ADMIN_PASSWORD\s*=\s*['"]/);
    // The header that carried it to the service-role endpoints.
    expect(html).not.toMatch(/['"]x-admin-key['"]\s*:/);
  });

  test('no admin endpoint accepts an x-admin-key header any more', () => {
    for (const f of ['api/admin-data.js', 'api/admin-analytics.js', 'api/admin-feedback.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      expect(src, f).not.toMatch(/req\.headers\[['"]x-admin-key['"]\]/);
      expect(src, f).not.toMatch(/ADMIN_PASSWORD\s*=/);
    }
  });

  test('fails closed: ADMIN_USER_IDS unset returns 503 and reads nothing', async () => {
    const calls = stubFetch({});
    const handler = load('api/admin-data.js');
    const res = mockRes();
    await handler(mockReq({ method: 'GET', headers: { authorization: 'Bearer anything' } }), res);
    expect(res.statusCode).toBe(503);
    expect(calls.length).toBe(0); // never reached Supabase
  });

  test('unauthenticated request is rejected with 401', async () => {
    process.env.ADMIN_USER_IDS = ADMIN_ID;
    const calls = stubFetch({});
    const handler = load('api/admin-data.js');
    const res = mockRes();
    await handler(mockReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(401);
    expect(calls.filter(c => c.url.indexOf('/rest/v1/') !== -1).length).toBe(0);
  });

  test('an ordinary signed-in user cannot read admin data (403)', async () => {
    process.env.ADMIN_USER_IDS = ADMIN_ID;
    const calls = stubFetch({ users: { tok_user: { id: USER_ID, email: 'user@example.com' } } });
    const handler = load('api/admin-data.js');
    const res = mockRes();
    await handler(mockReq({ method: 'GET', headers: { authorization: 'Bearer tok_user' } }), res);
    expect(res.statusCode).toBe(403);
    // Critically: no profile or CV query was issued for a non-admin.
    expect(calls.filter(c => c.url.indexOf('/rest/v1/') !== -1).length).toBe(0);
  });

  test('an admin gets data, and it carries no CV content or Stripe ids', async () => {
    process.env.ADMIN_USER_IDS = USER_ID + ',' + ADMIN_ID;
    const calls = stubFetch({
      users: { tok_admin: { id: ADMIN_ID, email: 'admin@example.com' } },
      rows: (url) => url.indexOf('profiles') !== -1
        ? [{ id: USER_ID, email: 'u@example.com', full_name: 'U', plan: 'pro', created_at: 'x' }]
        : [{ id: 'cv1', user_id: USER_ID, cv_name: 'My CV', template: 'professional', score: 80, updated_at: 'y' }],
    });
    const handler = load('api/admin-data.js');
    const res = mockRes();
    await handler(mockReq({ method: 'GET', headers: { authorization: 'Bearer tok_admin' } }), res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.profiles)).toBe(true);

    // The bulk list must not be able to carry CV content or Stripe ids.
    const asText = JSON.stringify(res.body);
    expect(asText).not.toContain('cv_data');
    expect(asText).not.toContain('stripe_customer_id');

    // And the queries themselves must be column-scoped, not select=*.
    const rest = calls.filter(c => c.url.indexOf('/rest/v1/') !== -1).map(c => c.url);
    expect(rest.length).toBeGreaterThan(0);
    for (const u of rest) {
      expect(u).not.toContain('select=*');
      if (u.indexOf('saved_cvs') !== -1) expect(u).not.toContain('cv_data');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C-2 — api/payment.js had no authentication and took userId from the body,
//       so any caller could read, cancel or open a billing portal for anyone.
// ───────────────────────────────────────────────────────────────────────────

test.describe('C-2 payment authentication', () => {

  const ACTIONS = ['create-checkout', 'get-subscription', 'confirm-payment', 'cancel', 'create-portal'];

  for (const action of ACTIONS) {
    test(`${action} rejects an unauthenticated request with 401`, async () => {
      const calls = stubFetch({});
      const handler = load('api/payment.js');
      const res = mockRes();
      await handler(mockReq({ query: { action }, body: { userId: VICTIM_ID } }), res);
      expect(res.statusCode).toBe(401);
      // No Stripe or Supabase work was done on an unauthenticated request.
      expect(calls.filter(c => c.url.indexOf('/rest/v1/') !== -1).length).toBe(0);
    });
  }

  test('create-portal ignores a userId in the body and uses the session identity', async () => {
    const calls = stubFetch({
      users: { tok_user: { id: USER_ID, email: 'user@example.com' } },
      rows: [], // no profile -> handler stops before any Stripe call
    });
    const handler = load('api/payment.js');
    const res = mockRes();
    await handler(mockReq({
      query: { action: 'create-portal' },
      headers: { authorization: 'Bearer tok_user' },
      body: { userId: VICTIM_ID },          // the attack: someone else's id
    }), res);

    const rest = calls.filter(c => c.url.indexOf('/rest/v1/') !== -1).map(c => c.url);
    expect(rest.length).toBeGreaterThan(0);
    // The victim id must appear in no outbound query at all.
    for (const u of rest) {
      expect(u).not.toContain(VICTIM_ID);
      expect(u).toContain(USER_ID);
    }
    // With no profile row it must refuse rather than fall through.
    expect(res.statusCode).not.toBe(200);
  });

  test('get-subscription is scoped to the caller, not the body', async () => {
    const calls = stubFetch({
      users: { tok_user: { id: USER_ID, email: 'user@example.com' } },
      rows: [{ plan: 'pro', stripe_customer_id: null, stripe_subscription_id: null }],
    });
    const handler = load('api/payment.js');
    const res = mockRes();
    await handler(mockReq({
      query: { action: 'get-subscription' },
      headers: { authorization: 'Bearer tok_user' },
      body: { userId: VICTIM_ID },
    }), res);

    expect(res.statusCode).toBe(200);
    const rest = calls.filter(c => c.url.indexOf('profiles') !== -1).map(c => c.url);
    expect(rest.length).toBeGreaterThan(0);
    for (const u of rest) {
      expect(u).toContain(USER_ID);
      expect(u).not.toContain(VICTIM_ID);
    }
  });

  test('no payment handler reads an identity from the request body', () => {
    const src = fs.readFileSync(path.join(REPO, 'api/payment.js'), 'utf8');
    // userId / email must never be destructured out of req.body again.
    expect(src).not.toMatch(/const\s*\{[^}]*\buserId\b[^}]*\}\s*=\s*req\.body/);
    expect(src).not.toMatch(/const\s*\{[^}]*\bemail\b[^}]*\}\s*=\s*req\.body/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C-3 — webhook signature verification was skipped whenever the
//       stripe-signature header was absent, in two separate endpoints.
// ───────────────────────────────────────────────────────────────────────────

test.describe('C-3 webhook signature verification', () => {

  function signed(payload) {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    return stripe.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET });
  }

  const EVENT = JSON.stringify({
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: { object: { metadata: { userId: USER_ID, planKey: 'day_pass' }, payment_status: 'paid', customer: 'cus_test' } },
  });

  test('fails closed when STRIPE_WEBHOOK_SECRET is not configured', async () => {
    const calls = stubFetch({});
    const { handleStripeWebhook } = load('api/_stripe-events.js');
    const res = mockRes();
    await handleStripeWebhook(streamReq(EVENT, { 'stripe-signature': 'anything' }), res);
    expect(res.statusCode).toBe(500);
    expect(calls.length).toBe(0); // nothing processed
  });

  test('rejects a request with no signature header (the original bypass)', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
    const calls = stubFetch({});
    const { handleStripeWebhook } = load('api/_stripe-events.js');
    const res = mockRes();
    await handleStripeWebhook(streamReq(EVENT, {}), res);
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0); // no plan was granted
  });

  test('rejects an invalid signature', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
    const calls = stubFetch({});
    const { handleStripeWebhook } = load('api/_stripe-events.js');
    const res = mockRes();
    await handleStripeWebhook(
      streamReq(EVENT, { 'stripe-signature': 't=1,v1=' + 'de:ad'.repeat(12) }), res);
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0);
  });

  test('rejects a correctly signed but malformed payload', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
    const calls = stubFetch({});
    const { handleStripeWebhook } = load('api/_stripe-events.js');
    const bad = '{ not json at all';
    const res = mockRes();
    await handleStripeWebhook(streamReq(bad, { 'stripe-signature': signed(bad) }), res);
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0);
  });

  test('rejects a signature valid for a DIFFERENT body (tamper check)', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
    const calls = stubFetch({});
    const { handleStripeWebhook } = load('api/_stripe-events.js');
    const tampered = EVENT.replace(USER_ID, VICTIM_ID);
    const res = mockRes();
    // Signature computed over the ORIGINAL body, sent with the tampered one.
    await handleStripeWebhook(streamReq(tampered, { 'stripe-signature': signed(EVENT) }), res);
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0);
  });

  test('accepts a validly signed event and applies it', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
    const calls = stubFetch({});
    const { handleStripeWebhook } = load('api/_stripe-events.js');
    const res = mockRes();
    await handleStripeWebhook(streamReq(EVENT, { 'stripe-signature': signed(EVENT) }), res);

    expect(res.statusCode).toBe(200);
    const writes = calls.filter(c => c.url.indexOf('profiles') !== -1 && c.init.method === 'POST');
    expect(writes.length).toBe(1);
    const body = JSON.parse(writes[0].init.body);
    expect(body.id).toBe(USER_ID);
    expect(body.plan).toBe('day_pass');
  });

  test('refuses to verify when the raw body has already been parsed', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
    const calls = stubFetch({});
    const { handleStripeWebhook } = load('api/_stripe-events.js');
    const res = mockRes();
    // A pre-parsed object: the exact signed bytes are unrecoverable, so the
    // only safe answer is refusal, never a re-serialised comparison.
    await handleStripeWebhook(
      mockReq({ headers: { 'stripe-signature': signed(EVENT) }, body: JSON.parse(EVENT) }), res);
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0);
  });

  test('signature verification exists in exactly one place', () => {
    const shared = fs.readFileSync(path.join(REPO, 'api/_stripe-events.js'), 'utf8');
    expect(shared).toContain('constructEvent');

    for (const f of ['api/webhook.js', 'api/payment.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      expect(src, f + ' must not verify signatures itself').not.toContain('constructEvent');
      // The unsafe guard that caused C-3 must not reappear anywhere.
      expect(src, f).not.toMatch(/if\s*\(\s*secret\s*&&\s*sig\s*\)/);
    }
  });
});
