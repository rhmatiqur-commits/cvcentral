/**
 * CV Central — shared Stripe webhook verification and event processing.
 *
 * Why this module exists (remediation of audit finding C-3): signature
 * verification was previously written twice, in api/webhook.js and again in
 * api/payment.js (?action=webhook), and BOTH used the same unsafe condition:
 *
 *     if (secret && sig) { verify } else { JSON.parse(rawBody) }
 *
 * Because the guard required *both* values, a caller who simply omitted the
 * stripe-signature header fell into the else branch and had arbitrary JSON
 * accepted as a genuine Stripe event — which upserts profiles.plan for any
 * user id the attacker chose. Setting STRIPE_WEBHOOK_SECRET did not mitigate
 * it, and fixing one of the two endpoints would have left the other open.
 *
 * This module is the single implementation. It fails closed:
 *   - no STRIPE_WEBHOOK_SECRET  -> 500, nothing processed
 *   - no stripe-signature       -> 400, nothing processed
 *   - signature does not verify -> 400, nothing processed
 *   - raw bytes unavailable     -> 400, nothing processed (never "verify"
 *                                  against a re-serialised body)
 *
 * Verification uses stripe.webhooks.constructEvent against the unmodified
 * request body, via the official library.
 *
 * Files beginning with an underscore are not routed as functions by Vercel,
 * so this does not consume one of the twelve function slots.
 */

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

function getStripe() {
  const Stripe = require('stripe');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
}

/**
 * Returns the exact bytes Stripe signed, or null when they cannot be known.
 *
 * THE ORDER HERE IS LOAD-BEARING.
 *
 * On Vercel's Node runtime `req.body` is a lazy getter. The platform
 * documents it as "only computed when it is accessed", and computing it
 * drains the request stream and parses the result — for Stripe's
 * application/json that produces an object, and the original bytes are then
 * gone for good. So the stream is read FIRST, and `req.body` is not touched
 * at all while the stream can still provide anything.
 *
 * An earlier revision of this file inspected `req.body` on its first line.
 * That access alone triggered the getter, so every signature check failed
 * with 400 — safely, but it would have stopped every subscription
 * activation, renewal and cancellation. Hence the comment, and the
 * regression test that reproduces it with a lazy getter.
 *
 * Note this needs no platform configuration. `config.api.bodyParser` is a
 * Next.js API-route option and is not honoured for standalone functions in
 * api/, and NODEJS_HELPERS=0 would disable `req.query` across the whole API,
 * which several endpoints route on.
 *
 * The fallback exists because nothing guarantees the stream is still
 * readable in every deployment configuration — something upstream may
 * already have consumed it. Then the bytes survive only if the platform
 * handed us a Buffer (application/octet-stream) or a string (text/plain).
 * A parsed object cannot be turned back into the signed bytes, and
 * re-serialising it would produce a different payload that could never
 * verify, so that path returns null and the caller refuses the request.
 * Pretending to verify would be worse than not verifying, because it would
 * look correct.
 */
function readRawBody(req) {
  const canStream =
    typeof req.on === 'function' &&
    req.readableEnded !== true &&
    req.readable !== false;

  if (canStream) {
    return new Promise(function (resolve, reject) {
      const chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () { resolve(Buffer.concat(chunks)); });
      req.on('error', reject);
    });
  }

  return Promise.resolve(bodyAsRawBytes(req));
}

/**
 * Last resort, reached only once the stream can no longer be read — so
 * touching the getter at this point cannot lose anything not already lost.
 */
function bodyAsRawBytes(req) {
  let body;
  try {
    body = req.body;
  } catch (e) {
    // Vercel's getter throws on malformed JSON. Nothing verifiable here.
    return null;
  }
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string' && body.length) return Buffer.from(body, 'utf8');
  return null; // parsed object, or no body at all
}

/** Verifies the signature, then processes the event. Always fails closed. */
async function handleStripeWebhook(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set - refusing to process');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[webhook] STRIPE_SECRET_KEY is not set - refusing to process');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    console.warn('[webhook] rejected: no stripe-signature header');
    return res.status(400).json({ error: 'Missing signature' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    console.error('[webhook] could not read body:', err.message);
    return res.status(400).json({ error: 'Invalid payload' });
  }
  if (!raw || !raw.length) {
    console.error('[webhook] rejected: raw body unavailable - is a body parser enabled?');
    return res.status(400).json({ error: 'Invalid payload' });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    // Covers bad signature, wrong secret, malformed JSON and stale
    // timestamps - constructEvent checks all of them.
    console.warn('[webhook] signature rejected:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    await processEvent(event);
  } catch (err) {
    // 200 so Stripe stops retrying a payload we have accepted but failed to
    // apply; the error is logged for manual reconciliation.
    console.error('[webhook] processing error for', event.type, err);
  }

  return res.status(200).json({ received: true });
}

/**
 * Applies a VERIFIED event.
 *
 * metadata.userId is trusted here only because two things now hold: the event
 * is signature-verified as having come from Stripe, and the metadata was
 * written by our own create-checkout, which (after the C-2 fix) derives the
 * user id from a verified session rather than the request body. Neither alone
 * would be sufficient.
 *
 * Every write is an upsert keyed by user id, so redelivery of the same event
 * converges on the same row rather than duplicating state.
 */
async function processEvent(event) {
  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId  = session.metadata && session.metadata.userId;
      const planKey = session.metadata && session.metadata.planKey;
      if (!userId) break;

      if (planKey === 'day_pass' && session.payment_status === 'paid') {
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
        await updateUserPlan(userId, 'day_pass', session.customer, null, expiresAt);
        console.log('[webhook] day_pass activated:', userId);
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
      if (!user) break;

      if (sub.status === 'active' || sub.status === 'trialing') {
        await updateUserPlan(user.id, tier, sub.customer, sub.id);
        console.log('[webhook] updated:', user.id, '->', tier, '(' + sub.status + ')');
      } else if (sub.status === 'canceled' || sub.status === 'unpaid') {
        await updateUserPlan(user.id, 'free', sub.customer, null);
        console.log('[webhook] downgraded:', user.id);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub    = event.data.object;
      const userId = sub.metadata && sub.metadata.userId;
      const user   = userId ? { id: userId } : await getUserByStripeCustomerId(sub.customer);
      if (user) {
        await updateUserPlan(user.id, 'free', sub.customer, null);
        console.log('[webhook] cancelled:', user.id);
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      if (!invoice.subscription || !invoice.customer) break;
      const sub     = await getStripe().subscriptions.retrieve(invoice.subscription);
      const userId  = sub.metadata && sub.metadata.userId;
      const planKey = sub.metadata && sub.metadata.planKey;
      const user    = userId ? { id: userId } : await getUserByStripeCustomerId(invoice.customer);
      if (user && sub.status === 'active') {
        const tier = PLAN_TO_TIER[planKey] || 'pro';
        await updateUserPlan(user.id, tier, invoice.customer, invoice.subscription);
        console.log('[webhook] invoice paid:', user.id, '->', tier);
      }
      break;
    }

    case 'invoice.payment_failed': {
      // Unchanged behaviour: no downgrade here. Audit finding M-1 covers the
      // missing dunning path; it is out of scope for this security phase.
      console.warn('[webhook] payment failed for customer:', event.data.object.customer);
      break;
    }

    default:
      break;
  }
}

async function getUserByStripeCustomerId(customerId) {
  if (!customerId) return null;
  const resp = await fetch(
    SUPABASE_URL + '/rest/v1/profiles?stripe_customer_id=eq.' + encodeURIComponent(customerId),
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      },
    }
  );
  const rows = await resp.json().catch(function () { return null; });
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
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  // Status and user id only - the response body contains the profile row,
  // including the email address, and does not belong in function logs.
  if (!resp.ok) console.error('[updateUserPlan] failed', resp.status, 'user', userId);
  return resp.ok;
}

module.exports = {
  handleStripeWebhook, processEvent, readRawBody, bodyAsRawBytes,
  updateUserPlan, getUserByStripeCustomerId, PLAN_TO_TIER,
};
