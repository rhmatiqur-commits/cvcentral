/**
 * CV Central — Admin Feedback API (Vercel Serverless)
 *
 * The public `feedback` table has no client-readable RLS policy (only INSERT
 * is allowed for anon/authenticated — see Supabase migration
 * "tighten_feedback_read_access"), because the previous SELECT policy let
 * ANY signed-in user read every other user's feedback (name/email/message)
 * via the public anon key. This endpoint uses the Supabase service-role key
 * to read (and delete) feedback server-side.
 *
 * SECURITY (remediation of audit finding C-1): the previous `x-admin-key`
 * password gate shared a secret with admin.html, a publicly served page, so
 * the header value was public. Authorisation is now a verified Supabase
 * session listed in ADMIN_USER_IDS, enforced by requireAdmin(), failing
 * closed when that variable is unset.
 *
 * Methods:
 *   GET    /api/admin-feedback           — list all feedback, newest first
 *   DELETE /api/admin-feedback?id=<uuid> — delete one feedback row
 *
 * Auth: header  Authorization: Bearer <supabase access token>
 *
 * Env vars required:
 *   SUPABASE_URL          — https://xxxx.supabase.co (falls back to the known project URL)
 *   SUPABASE_SERVICE_KEY  — service role key (already set for api/payment.js)
 *   ADMIN_USER_IDS        — comma-separated Supabase user UUIDs. REQUIRED.
 */

const { requireAdmin } = require('./_auth');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await requireAdmin(req);
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message || 'Unauthorized' });
  }

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('[admin-feedback] SUPABASE_SERVICE_KEY not set');
    return res.status(503).json({ error: 'Service unavailable' });
  }

  try {
    if (req.method === 'GET') return await listFeedback(req, res);
    if (req.method === 'DELETE') return await deleteFeedback(req, res);
    return res.status(405).json({ error: 'Use GET or DELETE' });
  } catch (err) {
    console.error('[admin-feedback]', err);
    return res.status(500).json({ error: 'Admin feedback error' });
  }
};

async function supabaseQuery(path, method, body) {
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
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: response.ok, status: response.status, data };
}

async function listFeedback(req, res) {
  const result = await supabaseQuery('feedback?select=*&order=created_at.desc', 'GET');
  if (!result.ok) {
    console.error('[admin-feedback] list failed', result.status, result.data);
    return res.status(502).json({ error: 'Could not load feedback' });
  }
  return res.status(200).json({ feedback: result.data || [] });
}

async function deleteFeedback(req, res) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const result = await supabaseQuery('feedback?id=eq.' + encodeURIComponent(id), 'DELETE');
  if (!result.ok) {
    console.error('[admin-feedback] delete failed', result.status, result.data);
    return res.status(502).json({ error: 'Could not delete feedback' });
  }
  return res.status(200).json({ ok: true });
}
