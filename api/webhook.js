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
 * Raw body: signature verification needs the exact bytes Stripe signed.
 * _stripe-events.js reads the request stream before anything touches Vercel's
 * lazy `req.body` getter, which is what preserves them. No platform
 * configuration is involved — `config.api.bodyParser` is a Next.js API-route
 * option and is not honoured for standalone functions in api/, so an earlier
 * revision of this file exported it to no effect. Do not reintroduce it, and
 * do not add code here that reads `req.body` before the handler runs.
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
