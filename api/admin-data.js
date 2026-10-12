/**
 * CV Central — Admin Candidate Data API (Vercel Serverless)
 *
 * Reads `profiles` and `saved_cvs` with the service-role key, which bypasses
 * RLS, so authorisation here is the only thing standing between a request and
 * every user's personal data.
 *
 * SECURITY (remediation of audit finding C-1): this endpoint previously
 * accepted an `x-admin-key` header compared against a password that was also
 * hardcoded in admin.html — a page served publicly — so anyone who read the
 * page source could retrieve every profile and every CV in full. The password
 * gate is gone entirely. Authorisation is now a verified Supabase session
 * whose user id is listed in ADMIN_USER_IDS, checked server-side by
 * requireAdmin(), which fails closed when that variable is unset.
 *
 * Two further changes limit the blast radius if this endpoint is ever
 * mis-gated again:
 *   - `profiles` and `saved_cvs` are selected by explicit column list rather
 *     than `*`. Stripe ids are no longer returned at all.
 *   - CV *content* is no longer returned in bulk. The list gives metadata
 *     only; `?cvId=<uuid>` returns one CV's data, for the download action.
 *
 * Methods:
 *   GET /api/admin-data              — profiles + CV metadata
 *   GET /api/admin-data?cvId=<uuid>  — cv_data for a single CV
 *
 * Auth: header  Authorization: Bearer <supabase access token>
 *
 * Env vars required:
 *   SUPABASE_URL          — falls back to the known project URL
 *   SUPABASE_SERVICE_KEY  — service role key
 *   ADMIN_USER_IDS        — comma-separated Supabase user UUIDs. REQUIRED:
 *                           with it unset every request returns 503.
 */

const { requireAdmin } = require('./_auth');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';

// Explicit column lists. Anything not rendered by admin.html is not returned.
const PROFILE_FIELDS = 'id,email,full_name,plan,created_at';
const CV_META_FIELDS = 'id,user_id,cv_name,template,score,updated_at';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  // Authorise BEFORE touching configuration or the database, so an
  // unauthorised caller cannot probe deployment state either.
  try {
    await requireAdmin(req);
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message || 'Unauthorized' });
  }

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('[admin-data] SUPABASE_SERVICE_KEY not set');
    return res.status(503).json({ error: 'Service unavailable' });
  }

  try {
    const cvId = req.query && req.query.cvId;

    // Single CV content, on demand, for the per-CV download action.
    if (cvId) {
      const one = await supabaseQuery(
        'saved_cvs?id=eq.' + encodeURIComponent(cvId) +
        '&select=id,user_id,cv_name,template,score,updated_at,cv_data'
      );
      if (!one.ok) {
        console.error('[admin-data] cv fetch failed', one.status, one.data);
        return res.status(502).json({ error: 'Could not load CV' });
      }
      const row = Array.isArray(one.data) ? one.data[0] : null;
      if (!row) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ cv: row });
    }

    const [profiles, cvs] = await Promise.all([
      supabaseQuery('profiles?select=' + PROFILE_FIELDS + '&order=created_at.desc'),
      supabaseQuery('saved_cvs?select=' + CV_META_FIELDS + '&order=updated_at.desc')
    ]);

    if (!profiles.ok || !cvs.ok) {
      console.error('[admin-data] query failed',
        profiles.status, profiles.data, cvs.status, cvs.data);
      return res.status(502).json({ error: 'Could not load admin data' });
    }

    return res.status(200).json({
      profiles: profiles.data || [],
      cvs: cvs.data || []
    });
  } catch (err) {
    console.error('[admin-data]', err);
    return res.status(500).json({ error: 'Admin data error' });
  }
};

async function supabaseQuery(path) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { ok: response.ok, status: response.status, data };
}
