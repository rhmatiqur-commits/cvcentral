/**
 * CV Central — Stripe Webhook Handler
 *
 * Separate from api/payment.js so bodyParser can be disabled.
 * Vercel auto-parses bodies as JSON; that breaks Stripe signature
 * verification. This file disables parsing and reads the raw bytes.
 *
 * Set this endpoint in Stripe Dashboard:
 *   https://cvcentral.io/api/webhook
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET  — whsec_...
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

// Disable Vercel's built-in body parser so we can read raw bytes
module.exports.config = { api: { bodyParser: false } };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';

const PLAN_TO_TIER = {
  pro_monthly:           'pro',
  pro_annual:            'pro',
  premium_monthly:       'premium',
  premium_annual:        'premium',
  pro_monthly_trial:     'pro',
  pro_annual_trial:      'pro',
  premium_monthly_trial: 'premium',
  premium_annual_trial:  'premium',
  day_pass:              'day_pass',
};

// ── Read raw body from stream ─────────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Stripe helper ─────────────────────────────────────────────
function getStripe() {
  const Stripe = require('stripe');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
}

// ── Supabase helpers ──────────────────────────────────────────
async function getUserByStripeCustomerId(customerId) {
  const resp = await fetch(
    SUPABASE_URL + '/rest/v1/profiles?stripe_customer_id=eq.' + encodeURIComponent(customerId),
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      },
    }
  );
  const rows = await resp.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function updateUserPlan(userId, plan, stripeCustomerId, stripeSubscriptionId, planExpiresAt) {
  const body = { id: userId };
  if (plan !== undefined)                 body.plan = plan;
  if (stripeCustomerId !== undefined)     body.stripe_customer_id = stripeCustomerId;
  if (stripeSubscriptionId !== undefined) body.stripe_subscription_id = stripeSubscriptionId;
  if (planExpiresAt !== undefined)        body.plan_expires_at = planExpiresAt;

  const resp = await fetch(SUPABASE_URL + '/rest/v1/profiles', {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  console.log('[updateUserPlan]', resp.status, text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not set' });
  }

  const stripe = getStripe();
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await getRawBody(req);
    if (secret && sig) {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
    } else {
      console.warn('[webhook] No STRIPE_WEBHOOK_SECRET — skipping signature check');
      event = JSON.parse(rawBody.toString());
    }
  } catch (err) {
    console.error('[webhook] Signature error:', err.message);
    return res.status(400).json({ error: 'Webhook error: ' + err.message });
  }

  console.log('[webhook]', event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata && session.metadata.userId;
        const planKey = session.metadata && session.metadata.planKey;
        if (!userId) break;

        if (planKey === 'day_pass' && session.payment_status === 'paid') {
          const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
          await updateUserPlan(userId, 'day_pass', session.customer, null, expiresAt);
          console.log('[webhook] day_pass activated:', userId, 'expires:', expiresAt);
        } else if (session.subscription) {
          const tier = PLAN_TO_TIER[planKey] || 'pro';
          await updateUserPlan(userId, tier, session.customer, session.subscription);
          console.log('[webhook] activated:', userId, '->', tier);
        }
        break;
      }

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

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription && invoice.customer) {
          const sub     = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId  = sub.metadata && sub.metadata.userId;
          const planKey = sub.metadata && sub.metadata.planKey;
          const user    = userId ? { id: userId } : await getUserByStripeCustomerId(invoice.customer);
          if (user && sub.status === 'active') {
            const tier = PLAN_TO_TIER[planKey] || 'pro';
            await updateUserPlan(user.id, tier, invoice.customer, invoice.subscription);
            console.log('[webhook] invoice paid:', user.id, '->', tier);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn('[webhook] Payment failed for customer:', invoice.customer, '— not downgrading yet');
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error('[webhook] Processing error:', err);
    // Return 200 so Stripe doesn't retry endlessly
  }

  return res.status(200).json({ received: true });
};
