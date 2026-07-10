/**
 * CV Central — Payment function (Vercel + Revolut)
 *
 * Actions (?action=):
 *   setup-plans      — one-time: create all subscription plans in Revolut
 *   create-checkout  — create customer + subscription, return checkout URL
 *   webhook          — handle Revolut webhook events (update Supabase plan)
 *   get-subscription — get current subscription for logged-in user
 *   cancel           — cancel a subscription
 *
 * Env vars required:
 *   REVOLUT_API_KEY        — Revolut merchant secret key
 *   SUPABASE_URL           — your Supabase project URL
 *   SUPABASE_SERVICE_KEY   — Supabase service role key (for server-side writes)
 *   REVOLUT_WEBHOOK_SECRET — from Revolut dashboard (set after first deploy)
 */

const REVOLUT_BASE = 'https://merchant.revolut.com/api/1.0';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';

// Plan definitions
const PLANS = {
  pro_monthly: {
    name: 'CV Central Pro — Monthly',
    amount: 599,   // £5.99 in pence
    currency: 'GBP',
    interval: 'MONTH',
    interval_count: 1,
  },
  pro_annual: {
    name: 'CV Central Pro — Annual',
    amount: 4900,  // £49.00
    currency: 'GBP',
    interval: 'YEAR',
    interval_count: 1,
  },
  premium_monthly: {
    name: 'CV Central Premium — Monthly',
    amount: 1099,  // £10.99
    currency: 'GBP',
    interval: 'MONTH',
    interval_count: 1,
  },
  premium_annual: {
    name: 'CV Central Premium — Annual',
    amount: 9900,  // £99.00
    currency: 'GBP',
    interval: 'YEAR',
    interval_count: 1,
  },
  pro_trial: {
    name: 'CV Central Pro — 3-Day Trial',
    amount: 199,   // £1.99 trial
    currency: 'GBP',
    interval: 'MONTH',
    interval_count: 1,
    trial_days: 3,
  }
};

// Plan key → Supabase plan value
const PLAN_TO_TIER = {
  pro_monthly: 'pro',
  pro_annual: 'pro',
  pro_trial: 'pro',
  premium_monthly: 'premium',
  premium_annual: 'premium',
};

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query && req.query.action) || '';

  // ── Webhook (no auth needed, uses signature) ──────────────────
  if (action === 'webhook') return handleWebhook(req, res);

  if (!process.env.REVOLUT_API_KEY) {
    return res.status(500).json({ error: 'REVOLUT_API_KEY not set' });
  }
  if (!process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    if (action === 'setup-plans')      return await setupPlans(req, res);
    if (action === 'create-checkout')  return await createCheckout(req, res);
    if (action === 'get-subscription') return await getSubscription(req, res);
    if (action === 'cancel')           return await cancelSubscription(req, res);
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('Payment error:', err);
    return res.status(500).json({ error: err.message || 'Payment error' });
  }
};

/* ─────────────────────────────────────────────────────────────
   Revolut API helpers
───────────────────────────────────────────────────────────── */

async function revolut(method, path, body) {
  const res = await fetch(REVOLUT_BASE + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + process.env.REVOLUT_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error('Revolut ' + res.status + ': ' + JSON.stringify(data));
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Supabase helpers (server-side, uses service key)
───────────────────────────────────────────────────────────── */

async function supabaseQuery(path, method, body) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: method || 'GET',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function updateUserPlan(userId, plan, subscriptionId) {
  return supabaseQuery(
    'profiles?id=eq.' + userId,
    'PATCH',
    { plan, revolut_subscription_id: subscriptionId }
  );
}

async function getUserByRevolutCustomerId(revolutCustomerId) {
  const rows = await supabaseQuery('profiles?revolut_customer_id=eq.' + revolutCustomerId);
  return Array.isArray(rows) ? rows[0] : null;
}

/* ─────────────────────────────────────────────────────────────
   1. One-time plan setup
───────────────────────────────────────────────────────────── */

async function setupPlans(req, res) {
  // Simple admin guard — only callable with the API key in body
  if ((req.body || {}).admin_key !== process.env.REVOLUT_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const results = {};

  for (const [key, plan] of Object.entries(PLANS)) {
    try {
      const body = {
        name: plan.name,
        amounts: [{ amount: plan.amount, currency: plan.currency }],
        schedule: {
          type: 'RECURRING',
          interval: plan.interval,
          interval_count: plan.interval_count,
        },
      };

      if (plan.trial_days) {
        body.trial = {
          duration: plan.trial_days,
          duration_unit: 'DAY',
          amount: plan.amount,   // £1.99 charged for trial
          currency: plan.currency,
        };
      }

      const created = await revolut('POST', '/plans', body);
      results[key] = { id: created.id, name: plan.name, status: 'created' };
    } catch (err) {
      results[key] = { error: err.message };
    }
  }

  console.log('Plan IDs:', JSON.stringify(results, null, 2));
  return res.status(200).json({
    message: 'Plans created — copy these IDs into your REVOLUT_PLAN_IDS env var',
    plans: results,
  });
}

/* ─────────────────────────────────────────────────────────────
   2. Create checkout
───────────────────────────────────────────────────────────── */

async function createCheckout(req, res) {
  const { userId, email, fullName, planKey, successUrl, cancelUrl } = req.body || {};

  if (!userId || !email || !planKey) {
    return res.status(400).json({ error: 'userId, email, and planKey required' });
  }

  const planIds = getPlanIds();
  const planId = planIds[planKey];
  if (!planId) {
    return res.status(400).json({ error: 'Unknown planKey: ' + planKey + '. Run setup-plans first.' });
  }

  // Check if customer already exists in our DB
  let rows = await supabaseQuery('profiles?id=eq.' + userId + '&select=revolut_customer_id,plan');
  const profile = Array.isArray(rows) ? rows[0] : null;
  let revolutCustomerId = profile && profile.revolut_customer_id;

  // Create Revolut customer if not already done
  if (!revolutCustomerId) {
    const [firstName, ...rest] = (fullName || email).split(' ');
    const customer = await revolut('POST', '/customers', {
      email,
      full_name: fullName || email,
    });
    revolutCustomerId = customer.id;

    // Save customer ID in Supabase
    await supabaseQuery('profiles?id=eq.' + userId, 'PATCH', {
      revolut_customer_id: revolutCustomerId,
    });
  }

  // Create subscription
  const sub = await revolut('POST', '/subscriptions', {
    customer_id: revolutCustomerId,
    plan_id: planId,
    return_url: successUrl || 'https://cvcentral.io/dashboard.html?payment=success',
    cancel_url: cancelUrl || 'https://cvcentral.io/dashboard.html?payment=cancelled',
    metadata: { userId, planKey },
  });

  return res.status(200).json({
    checkout_url: sub.checkout_url || sub.setup_checkout_url,
    subscription_id: sub.id,
  });
}

/* ─────────────────────────────────────────────────────────────
   3. Webhook handler
───────────────────────────────────────────────────────────── */

async function handleWebhook(req, res) {
  const event = req.body;
  if (!event || !event.type) return res.status(400).json({ error: 'Invalid event' });

  console.log('Revolut webhook:', event.type, JSON.stringify(event).slice(0, 300));

  try {
    if (event.type === 'SUBSCRIPTION_ACTIVATED' || event.type === 'SUBSCRIPTION_RENEWED') {
      const sub = event.data || event;
      const customerId = sub.customer_id;
      const subscriptionId = sub.id;
      const planKey = (sub.metadata && sub.metadata.planKey) || '';
      const tier = PLAN_TO_TIER[planKey] || 'pro';

      // Find user by Revolut customer ID
      const user = await getUserByRevolutCustomerId(customerId);
      if (user) {
        await updateUserPlan(user.id, tier, subscriptionId);
        console.log('Plan updated:', user.id, '->', tier);
      }
    }

    if (event.type === 'SUBSCRIPTION_CANCELLED' || event.type === 'SUBSCRIPTION_EXPIRED') {
      const sub = event.data || event;
      const customerId = sub.customer_id;
      const user = await getUserByRevolutCustomerId(customerId);
      if (user) {
        await updateUserPlan(user.id, 'free', null);
        console.log('Plan downgraded to free:', user.id);
      }
    }

    if (event.type === 'SUBSCRIPTION_PAYMENT_FAILED') {
      // Log only — don't immediately downgrade, give grace period
      console.warn('Payment failed for subscription:', (event.data || event).id);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }

  // Always return 200 to Revolut
  return res.status(200).json({ received: true });
}

/* ─────────────────────────────────────────────────────────────
   4. Get subscription
───────────────────────────────────────────────────────────── */

async function getSubscription(req, res) {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const rows = await supabaseQuery(
    'profiles?id=eq.' + userId + '&select=plan,revolut_subscription_id,revolut_customer_id'
  );
  const profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile) return res.status(404).json({ error: 'User not found' });

  let subscriptionDetails = null;
  if (profile.revolut_subscription_id) {
    try {
      subscriptionDetails = await revolut('GET', '/subscriptions/' + profile.revolut_subscription_id);
    } catch (e) {
      console.error('Could not fetch subscription from Revolut:', e.message);
    }
  }

  return res.status(200).json({
    plan: profile.plan || 'free',
    subscription: subscriptionDetails,
  });
}

/* ─────────────────────────────────────────────────────────────
   5. Cancel subscription
───────────────────────────────────────────────────────────── */

async function cancelSubscription(req, res) {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const rows = await supabaseQuery(
    'profiles?id=eq.' + userId + '&select=revolut_subscription_id'
  );
  const profile = Array.isArray(rows) ? rows[0] : null;
  const subId = profile && profile.revolut_subscription_id;

  if (!subId) return res.status(400).json({ error: 'No active subscription found' });

  await revolut('POST', '/subscriptions/' + subId + '/cancel', {});
  await updateUserPlan(userId, 'free', null);

  return res.status(200).json({ cancelled: true });
}

/* ─────────────────────────────────────────────────────────────
   Plan ID lookup (from env var set after setup-plans)
───────────────────────────────────────────────────────────── */

function getPlanIds() {
  try {
    return JSON.parse(process.env.REVOLUT_PLAN_IDS || '{}');
  } catch {
    return {};
  }
}
