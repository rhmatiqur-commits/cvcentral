/**
 * CV Central — shared server-side auth + plan/rate-limit helper.
 * Used by api/ai.js and api/chat.js.
 *
 * Why this exists: previously these endpoints trusted whatever `plan` the
 * client sent in the request body, and had no authentication at all — any
 * script could POST directly to /api/ai claiming plan:"pro" and get
 * unlimited Sonnet-tier generations for free. This module verifies a real
 * Supabase session, looks up the user's actual plan server-side, and caps
 * requests per day so a single bad actor or bug can't burn the Anthropic
 * budget.
 *
 * Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (already configured
 * for api/payment.js). SUPABASE_ANON_KEY is optional — falls back to the
 * same public anon key already shipped in js/auth.js (anon keys are meant
 * to be public; this is not a secret).
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4emttYXZrenFrbm9naG9wd2hxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NjI5MjMsImV4cCI6MjA5ODMzODkyM30.ZiQSoZ2bTErHX-zHa6QQ-P2TD5eNgoPfB--Bpnk9R5I';

// Daily request caps per plan. Deliberately generous for real usage during
// the test-cohort phase, tight enough that a scripted abuser gets capped
// fast. Tune once real usage patterns are known.
const DAILY_CAP = { free: 15, day_pass: 60, pro: 60, premium: 100 };

async function supabaseRest(path, opts) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({
    headers: Object.assign({
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    }, (opts && opts.headers) || {})
  }, opts));
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { ok: response.ok, status: response.status, data: data };
}

/** Verifies the bearer token in the Authorization header against Supabase Auth. */
async function verifyUser(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  const token = header && header.indexOf('Bearer ') === 0 ? header.slice(7) : null;
  if (!token) {
    const e = new Error('Please sign in to use this feature.');
    e.status = 401;
    throw e;
  }
  const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
  });
  if (!response.ok) {
    const e = new Error('Your session has expired — please sign in again.');
    e.status = 401;
    throw e;
  }
  return response.json(); // { id, email, ... }
}

/** Looks up the user's real plan server-side. Mirrors the day_pass-expiry logic used client-side (see cv-builder.html isPro()). */
async function getRealPlan(userId) {
  if (!process.env.SUPABASE_SERVICE_KEY) return 'free';
  const { data } = await supabaseRest('profiles?id=eq.' + userId + '&select=plan,plan_expires_at');
  const profile = Array.isArray(data) ? data[0] : null;
  if (!profile || !profile.plan) return 'free';
  if (profile.plan === 'day_pass') {
    if (profile.plan_expires_at && new Date(profile.plan_expires_at) > new Date()) return 'day_pass';
    return 'free';
  }
  return profile.plan;
}

/**
 * Increments today's request count for this user and throws (429) if over
 * their daily cap. Not perfectly atomic under heavy concurrency, and fails
 * open (allows the request) if the usage table is unreachable — good
 * enough to stop scripted abuse without ever blocking a real user over a
 * transient DB hiccup.
 */
async function checkRateLimit(userId, plan) {
  if (!process.env.SUPABASE_SERVICE_KEY) return;
  const cap = DAILY_CAP[plan] || DAILY_CAP.free;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data: rows } = await supabaseRest('ai_usage?user_id=eq.' + userId + '&day=eq.' + today + '&select=count');
    const existing = Array.isArray(rows) ? rows[0] : null;
    const currentCount = existing ? existing.count : 0;
    if (currentCount >= cap) {
      const e = new Error("You've hit today's AI usage limit. This resets at midnight UTC.");
      e.status = 429;
      throw e;
    }
    await supabaseRest('ai_usage', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: userId, day: today, count: currentCount + 1 })
    });
  } catch (e) {
    if (e.status === 429) throw e;
    console.error('[rate-limit] check failed, failing open:', e.message);
  }
}

/** Full auth + real-plan + rate-limit pipeline for an incoming API request. */
async function authenticate(req) {
  const user = await verifyUser(req);
  const plan = await getRealPlan(user.id);
  await checkRateLimit(user.id, plan);
  return { userId: user.id, plan: plan };
}

module.exports = { authenticate, verifyUser, getRealPlan, checkRateLimit };
