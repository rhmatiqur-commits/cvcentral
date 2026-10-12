/**
 * CV Central — Stripe webhook endpoint.
 *
 * POST /api/webhook
 *
 * This is the single webhook entry point. All verification and event
 * processing lives in api/_stripe-events.js so that there is exactly one
 * implementation; the previous arrangement had the logic duplicated here and
 * in api/payment.js, with the same signature-bypass bug in both (audit
 * finding C-3).
 *
 * Env vars required:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET  — REQUIRED. Without it this endpoint returns 500
 *                            and processes nothing, rather than accepting
 *                            unsigned events as it used to.
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const { handleStripeWebhook } = require('./_stripe-events');

module.exports = async (req, res) => handleStripeWebhook(req, res);

// Signature verification must run against the unmodified request body, so the
// platform body parser is disabled for this route. With it enabled, req.body
// arrives pre-parsed, the exact signed bytes are unrecoverable, and
// _stripe-events.js correctly refuses the request rather than guessing.
module.exports.config = { api: { bodyParser: false } };
