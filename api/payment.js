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

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';

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

  // Webhook — no API key auth; uses Stripe signature
  if (action === 'webhook') return handleWebhook(req, res);

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not set' });
  }
  if (!process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    if (action === 'create-checkout')  return await createCheckout(req, res);
    if (action === 'get-subscription') return await getSubscription(req, res);
    if (action === 'confirm-payment')  return await confirmPayment(req, res);
    if (action === 'cancel')           return await cancelSubscription(req, res);
    if (action === 'create-portal')    return await createPortalSession(req, res);
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[payment]', err);
    return res.status(500).json({ error: err.message || 'Payment error' });
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
    'profiles?id=eq.' + userId + '&select=plan,stripe_customer_id,stripe_subscription_id,email'
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function getUserByStripeCustomerId(customerId) {
  const rows = await supabaseQuery('profiles?stripe_customer_id=eq.' + encodeURIComponent(customerId));
  return Array.isArray(rows) ? rows[0] : null;
}

async function updateUserPlan(userId, plan, stripeCustomerId, stripeSubscriptionId) {
  // Use upsert so this works even if no profile row exists yet
  const body = { id: userId };
  if (plan !== undefined)                body.plan = plan;
  if (stripeCustomerId !== undefined)    body.stripe_customer_id = stripeCustomerId;
  if (stripeSubscriptionId !== undefined) body.stripe_subscription_id = stripeSubscriptionId;

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

async function createCheckout(req, res) {
  const { userId, email, fullName, planKey, successUrl, cancelUrl } = req.body || {};

  if (!userId || !email || !planKey) {
    return res.status(400).json({ error: 'userId, email, and planKey required' });
  }

  const isTrial = planKey.endsWith('_trial');
  const basePlanKey = planKey.replace('_trial', '');
  const priceIds = getPriceIds();
  const priceId = priceIds[basePlanKey];

  if (!priceId) {
    return res.status(400).json({
      error: `No Stripe price for "${basePlanKey}". Add it to STRIPE_PRICE_IDS env var.`,
    });
  }

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
    // Save customer ID before checkout so webhook can find the user
    await updateUserPlan(userId, undefined, customerId, undefined);
  }

  const successBase = successUrl || 'https://cvcentral.io/dashboard.html';
  const cancelBase  = cancelUrl  || 'https://cvcentral.io/dashboard.html';

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
// 2. Webhook — handle Stripe events
// ─────────────────────────────────────────────────────────────

async function handleWebhook(req, res) {
  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  // Try to verify signature
  // Note: Vercel auto-parses the body as JSON, so we reconstruct the raw string.
  // This works for test events. For production, consider using a Next.js API route
  // with bodyParser: false, or the Stripe CLI for local testing.
  try {
    const rawBody = typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

    if (secret && sig) {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
    } else {
      // No secret configured — accept event without verification (sandbox only)
      console.warn('[webhook] No STRIPE_WEBHOOK_SECRET set — skipping signature check');
      event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    }
  } catch (err) {
    console.error('[webhook] Signature error:', err.message);
    return res.status(400).json({ error: 'Webhook error: ' + err.message });
  }

  console.log('[webhook]', event.type);

  try {
    switch (event.type) {

      // ── User completed checkout ──────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata && session.metadata.userId;
        const planKey = session.metadata && session.metadata.planKey;
        if (userId && session.subscription) {
          const tier = PLAN_TO_TIER[planKey] || 'pro';
          await updateUserPlan(userId, tier, session.customer, session.subscription);
          console.log('[webhook] activated:', userId, '->', tier);
        }
        break;
      }

      // ── Subscription changed ────────────────────────────────
      case 'customer.subscription.updated': {
        const sub     = event.data.object;
        const userId  = sub.metadata && sub.metadata.userId;
        const planKey = sub.metadata && sub.metadata.planKey;
        const tier    = PLAN_TO_TIER[planKey] || 'pro';
        const user    = userId ? { id: userId } : await getUserByStripeCustomerId(sub.customer);

        if (user) {
          if (sub.status === 'active' || sub.status === 'trialing') {
            await updateUserPlan(user.id, tier, sub.customer, sub.id);
            console.log('[webhook] updated:', user.id, '->', tier, '(' + sub.status + ')');
          } else if (sub.status === 'canceled' || sub.status === 'unpaid') {
            await updateUserPlan(user.id, 'free', sub.customer, null);
            console.log('[webhook] downgraded:', user.id, '-> free');
          }
        }
        break;
      }

      // ── Subscription cancelled ──────────────────────────────
      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const userId = sub.metadata && sub.metadata.userId;
        const user   = userId ? { id: userId } : await getUserByStripeCustomerId(sub.customer);
        if (user) {
          await updateUserPlan(user.id, 'free', sub.customer, null);
          console.log('[webhook] cancelled:', user.id, '-> free');
        }
        break;
      }

      // ── Payment succeeded (e.g. trial converted) ─────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription && invoice.customer) {
          const stripe = getStripe();
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId  = sub.metadata && sub.metadata.userId;
          const planKey = sub.metadata && sub.metadata.planKey;
          const user = userId ? { id: userId } : await getUserByStripeCustomerId(invoice.customer);
          if (user && sub.status === 'active') {
            const tier = PLAN_TO_TIER[planKey] || 'pro';
            await updateUserPlan(user.id, tier, invoice.customer, invoice.subscription);
            console.log('[webhook] invoice paid:', user.id, '->', tier);
          }
        }
        break;
      }

      // ── Payment failed ──────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn('[webhook] Payment failed for customer:', invoice.customer, '— not downgrading yet');
        // Stripe will retry. Downgrade only when subscription status → unpaid/canceled.
        break;
      }

      default:
        // Ignore other events
        break;
    }
  } catch (err) {
    console.error('[webhook] Processing error:', err);
    // Still return 200 so Stripe doesn't retry
  }

  return res.status(200).json({ received: true });
}

// ─────────────────────────────────────────────────────────────
// 3. Get subscription status
// ─────────────────────────────────────────────────────────────

async function getSubscription(req, res) {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const profile = await getUserProfile(userId);
  if (!profile) return res.status(404).json({ error: 'User not found' });

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

async function confirmPayment(req, res) {
  const { userId, sessionId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // Use the Stripe checkout session to confirm payment
  if (sessionId) {
    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log('[confirm-payment] session status:', session.status, 'payment_status:', session.payment_status);

      if (session.status === 'complete' || session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
        const planKey = session.metadata && session.metadata.planKey;
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

async function cancelSubscription(req, res) {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

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

async function createPortalSession(req, res) {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const profile = await getUserProfile(userId);
  const customerId = profile && profile.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: 'No Stripe customer found for this user' });

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
