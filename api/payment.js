/**
 * CV Central — Payment API (Vercel Serverless + Stripe)
 *
 * Actions (?action=):
 *   create-checkout  — create Stripe Checkout Session (subscription or trial)
 *   webhook          — handle Stripe webhook events (update Supabase)
 *   get-subscription — get current subscription for logged-in user
 *   confirm-payment  — verify after returning from Stripe Checkout
 *   cancel           — cancel at end of billing period
 *   create-portal    — Stripe customer portal (manage billing / cancel)
 *
 * Env vars required:
 *   STRIPE_SECRET_KEY      — sk_test_... (sandbox) or sk_live_... (production)
 *   STRIPE_PUBLISHABLE_KEY — pk_test_... or pk_live_... (for frontend)
 *   STRIPE_WEBHOOK_SECRET  — whsec_... (from Stripe webhook endpoint)
 *   STRIPE_PRICE_IDS       — JSON map of plan keys → Stripe price IDs:
 *                            {
 *                              "pro_monthly":      "price_xxx",
 *                              "pro_annual":       "price_xxx",
 *                              "premium_monthly":  "price_xxx",
 *                              "premium_annual":   "price_xxx",
 *                              "trial_fee":        "price_xxx"  ← £1.99 one-time
 *                            }
 *   SUPABASE_URL           — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY   — service role key (server-side writes)
 *
 * Trial flow:
 *   The "trial" plans charge £1.99 immediately (trial_fee one-time price) and
 *   then start a 14-day trial of the chosen plan. Card is saved and they are
 *   charged the regular amount when the trial ends.
 */

const { verifyUser } = require('./_auth');
const { handleStripeWebhook } = require('./_stripe-events');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';

// Redirect targets handed to Stripe must stay on our own origins, otherwise a
// caller could point a real Stripe checkout at a page they control.
const ALLOWED_REDIRECT_PREFIXES = [
  'https://cvcentral.io/',
  'https://www.cvcentral.io/',
];

function safeRedirect(url, fallback) {
  if (typeof url !== 'string') return fallback;
  for (var i = 0; i < ALLOWED_REDIRECT_PREFIXES.length; i++) {
    if (url.indexOf(ALLOWED_REDIRECT_PREFIXES[i]) === 0) return url;
  }
  return fallback;
}

// Hardcoded Job Pass price (£1.19 one-time, created 2026-07-16)
const DAY_PASS_PRICE_ID = 'price_1TtoeJRwetsWzvA0zINPt3Ht';

// Maps Stripe plan keys → Supabase plan tier
const PLAN_TO_TIER = {
  pro_monthly:          'pro',
  pro_annual:           'pro',
  premium_monthly:      'premium',
  premium_annual:       'premium',
  pro_monthly_trial:    'pro',
  pro_annual_trial:     'pro',
  premium_monthly_trial:'premium',
  premium_annual_trial: 'premium',
  day_pass:             'day_pass',
};

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query && req.query.action) || '';

  // Webhook — authenticated by Stripe signature, not by a user session.
  // Delegated to the single shared implementation (C-3).
  //
  // NOTE: this route cannot disable the platform body parser independently of
  // the rest of this function, so the exact signed bytes may not be
  // recoverable here. The shared handler then refuses the request rather than
  // guessing. /api/webhook is the supported endpoint - see DEPLOYMENT notes.
  if (action === 'webhook') return handleStripeWebhook(req, res);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  // SECURITY (remediation of audit finding C-2): every user-specific billing
  // action requires a verified Supabase session and takes its identity from
  // that session. A userId in the request body is ignored entirely.
  //
  // Previously each handler read userId straight from the body with no
  // authentication at all, so any caller could read another account's
  // subscription, cancel it, or mint a Stripe billing-portal link granting
  // interactive access to that billing account.
  let callerId, callerEmail;
  try {
    const caller = await verifyUser(req);
    callerId = caller.id;
    callerEmail = caller.email;
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message || 'Please sign in.' });
  }

  // Configuration is checked only after the caller is authenticated, so an
  // anonymous request cannot probe which environment variables are present.
  if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('[payment] missing STRIPE_SECRET_KEY or SUPABASE_SERVICE_KEY');
    return res.status(503).json({ error: 'Billing is temporarily unavailable' });
  }

  try {
    if (action === 'create-checkout')  return await createCheckout(req, res, callerId, callerEmail);
    if (action === 'get-subscription') return await getSubscription(req, res, callerId);
    if (action === 'confirm-payment')  return await confirmPayment(req, res, callerId);
    if (action === 'cancel')           return await cancelSubscription(req, res, callerId);
    if (action === 'create-portal')    return await createPortalSession(req, res, callerId);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    // Generic to the client; detail stays in the function log.
    console.error('[payment]', action, err);
    return res.status(500).json({ error: 'Payment error' });
  }
};

// ─────────────────────────────────────────────────────────────
// Stripe helper
// ─────────────────────────────────────────────────────────────

function getStripe() {
  const Stripe = require('stripe');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
}

// ─────────────────────────────────────────────────────────────
// Supabase helpers
// ─────────────────────────────────────────────────────────────

async function supabaseQuery(path, method = 'GET', body) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function getUserProfile(userId) {
  const rows = await supabaseQuery(
    'profiles?id=eq.' + userId + '&select=plan,stripe_customer_id,stripe_subscription_id,email,plan_expires_at'
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function updateUserPlan(userId, plan, stripeCustomerId, stripeSubscriptionId, planExpiresAt) {
  // Use upsert so this works even if no profile row exists yet
  const body = { id: userId };
  if (plan !== undefined)                body.plan = plan;
  if (stripeCustomerId !== undefined)    body.stripe_customer_id = stripeCustomerId;
  if (stripeSubscriptionId !== undefined) body.stripe_subscription_id = stripeSubscriptionId;
  if (planExpiresAt !== undefined)       body.plan_expires_at = planExpiresAt;

  const response = await fetch(SUPABASE_URL + '/rest/v1/profiles', {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  console.log('[updateUserPlan]', response.status, text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
}

// ─────────────────────────────────────────────────────────────
// 1. Create Checkout Session
// ─────────────────────────────────────────────────────────────

async function createCheckout(req, res, userId, verifiedEmail) {
  const { fullName, planKey, successUrl, cancelUrl } = req.body || {};

  // userId and email come from the verified session, never from the body.
  const email = verifiedEmail;
  if (!planKey) return res.status(400).json({ error: 'planKey required' });
  if (!email)   return res.status(400).json({ error: 'Account has no email address' });

  const stripe = getStripe();

  // Get or create Stripe customer
  const profile = await getUserProfile(userId);
  let customerId = profile && profile.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      name: fullName || undefined,
      metadata: { userId },
    });
    customerId = customer.id;
    await updateUserPlan(userId, undefined, customerId, undefined);
  }

  const successBase = safeRedirect(successUrl, 'https://cvcentral.io/dashboard.html');
  const cancelBase  = safeRedirect(cancelUrl,  'https://cvcentral.io/dashboard.html');

  // ── Job Pass (one-time payment, 72h Pro access) ──────────
  if (planKey === 'day_pass') {
    const priceId = getPriceIds()['day_pass'] || DAY_PASS_PRICE_ID;
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successBase + '?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  cancelBase  + '?payment=cancelled',
      metadata: { userId, planKey: 'day_pass' },
      custom_text: {
        submit: {
          message: 'One-time charge — no subscription, no auto-renewal. 72 hours of full Pro access starts immediately.',
        },
      },
    });
    return res.status(200).json({ checkout_url: session.url, session_id: session.id });
  }

  // ── Subscription / Trial flow ─────────────────────────────────
  const isTrial = planKey.endsWith('_trial');
  const basePlanKey = planKey.replace('_trial', '');
  const priceIds = getPriceIds();
  const priceId = priceIds[basePlanKey];

  if (!priceId) {
    console.error('[create-checkout] no Stripe price configured for', basePlanKey);
    return res.status(400).json({ error: 'That plan is not available right now.' });
  }

  // Base session params
  const sessionParams = {
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successBase + '?payment=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url:  cancelBase  + '?payment=cancelled',
    metadata: { userId, planKey },
    subscription_data: {
      metadata: { userId, planKey },
    },
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
  };

  if (isTrial) {
    // 14-day trial — card required
    // £1.99 charged immediately via one-time trial_fee price (added as invoice item)
    sessionParams.subscription_data.trial_period_days = 14;
    sessionParams.subscription_data.trial_settings = {
      end_behavior: { missing_payment_method: 'cancel' },
    };

    // Add £1.99 trial fee — will appear on the first (immediate) invoice
    // NOTE: With trial_period_days, Stripe creates a £0 subscription invoice right away,
    // then the regular charge kicks in after 14 days. The trial_fee appears on that first invoice.
    // To charge £1.99 UPFRONT instead, you'd need a two-step flow (payment then subscription).
    // For now we add it as an invoice item to the subscription's first renewal invoice.
    const trialFeePrice = priceIds['trial_fee'];
    if (trialFeePrice) {
      sessionParams.subscription_data.add_invoice_items = [{ price: trialFeePrice }];
    }

    // Custom copy for trial checkout
    sessionParams.custom_text = {
      submit: {
        message: 'Your card will be charged £1.99 for the 14-day trial, then the full plan price after.',
      },
    };
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  return res.status(200).json({
    checkout_url: session.url,
    session_id: session.id,
  });
}

// ─────────────────────────────────────────────────────────────
// 3. Get subscription status
// ─────────────────────────────────────────────────────────────

async function getSubscription(req, res, userId) {
  // Scoped to the authenticated caller; the Stripe ids are read from their
  // own profile row, so another account is not reachable.
  const profile = await getUserProfile(userId);
  if (!profile) return res.status(404).json({ error: 'Not found' });

  let subscription = null;
  if (profile.stripe_subscription_id) {
    try {
      const stripe = getStripe();
      subscription = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
    } catch (e) {
      console.error('[get-subscription]', e.message);
    }
  }

  return res.status(200).json({
    plan: profile.plan || 'free',
    subscription,
  });
}

// ─────────────────────────────────────────────────────────────
// 4. Confirm payment after redirect from Stripe
// ─────────────────────────────────────────────────────────────

async function confirmPayment(req, res, userId) {
  const { sessionId } = req.body || {};

  // Use the Stripe checkout session to confirm payment
  if (sessionId) {
    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log('[confirm-payment] session status:', session.status, 'payment_status:', session.payment_status);

      // Ownership check: the session must be the one this caller started.
      // Without it, any signed-in user could present a checkout session id
      // belonging to someone else and have a plan applied to their account.
      const sessionUserId = session.metadata && session.metadata.userId;
      if (sessionUserId !== userId) {
        console.warn('[confirm-payment] session/user mismatch for user', userId);
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (session.status === 'complete' || session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
        const planKey = session.metadata && session.metadata.planKey;
        if (planKey === 'day_pass') {
          // Check if already activated by webhook (plan_expires_at already set)
          const existingProfile = await getUserProfile(userId);
          if (existingProfile && existingProfile.plan === 'day_pass' && existingProfile.plan_expires_at) {
            return res.status(200).json({ plan: 'day_pass', updated: true, planExpiresAt: existingProfile.plan_expires_at });
          }
          // Webhook may not have fired yet — activate now
          const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
          await updateUserPlan(userId, 'day_pass', session.customer, null, expiresAt);
          return res.status(200).json({ plan: 'day_pass', updated: true, planExpiresAt: expiresAt });
        }
        const tier = PLAN_TO_TIER[planKey] || 'pro';
        await updateUserPlan(userId, tier, session.customer, session.subscription);
        return res.status(200).json({ plan: tier, updated: true });
      }
    } catch (e) {
      console.error('[confirm-payment]', e.message);
    }
  }

  // Fallback: return current plan from DB (profile may not exist yet)
  const profile = await getUserProfile(userId);
  return res.status(200).json({ plan: (profile && profile.plan) || 'free', updated: false });
}

// ─────────────────────────────────────────────────────────────
// 5. Cancel subscription (at period end)
// ─────────────────────────────────────────────────────────────

async function cancelSubscription(req, res, userId) {
  // The subscription id is read from the authenticated caller own profile
  // row, so a caller can only ever cancel their own subscription.
  const profile = await getUserProfile(userId);
  const subId = profile && profile.stripe_subscription_id;
  if (!subId) return res.status(400).json({ error: 'No active subscription found' });

  const stripe = getStripe();
  const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });

  return res.status(200).json({
    cancelled: true,
    cancel_at: sub.cancel_at,
    note: 'Access continues until end of current billing period',
  });
}

// ─────────────────────────────────────────────────────────────
// 6. Customer portal (manage billing, change plan, cancel)
// ─────────────────────────────────────────────────────────────

async function createPortalSession(req, res, userId) {
  // The Stripe customer is read from the authenticated caller own profile
  // row. This is the operation that previously allowed anyone holding a user
  // id to obtain a billing-portal link for that account.
  const profile = await getUserProfile(userId);
  const customerId = profile && profile.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: 'No billing account found' });

  const stripe = getStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: 'https://cvcentral.io/dashboard.html',
  });

  return res.status(200).json({ url: portal.url });
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function getPriceIds() {
  try { return JSON.parse(process.env.STRIPE_PRICE_IDS || '{}'); }
  catch { return {}; }
}
