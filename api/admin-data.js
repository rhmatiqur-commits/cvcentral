/**
 * CV Central — Admin Candidate Data API (Vercel Serverless)
 *
 * admin.html previously queried `profiles` and `saved_cvs` directly with the
 * public anon key, which is exactly right — those tables have RLS policies
 * scoped to `auth.uid() = id` / `auth.uid() = user_id`, so a signed-out admin
 * session got zero rows every time (the "no data returned" banner). This
 * endpoint uses the service-role key to read both tables server-side, gated
 * by the same admin password already used by admin.html's password gate and
 * api/admin-feedback.js.
 *
 * Method: GET /api/admin-data
 * Auth:   header  x-admin-key: <ADMIN_PASSWORD>
 *
 * Env vars required:
 *   SUPABASE_URL          — https://xxxx.supabase.co (falls back to the known project URL)
 *   SUPABASE_SERVICE_KEY  — service role key (already set for api/payment.js)
 *   ADMIN_PASSWORD        — optional; falls back to the password hardcoded in admin.html
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CVCentral2026!';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  if (!process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set' });
  }

  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [profiles, cvs] = await Promise.all([
      supabaseQuery('profiles?select=*&order=created_at.desc'),
      // Full row including cv_data — at cohort-test scale (50-100 users) this
      // is a few hundred KB at most, and the CVs modal / CSV export need the
      // real CV content, not just metadata.
      supabaseQuery('saved_cvs?select=*&order=updated_at.desc')
    ]);
    if (!profiles.ok) return res.status(profiles.status).json({ error: profiles.data });
    if (!cvs.ok) return res.status(cvs.status).json({ error: cvs.data });
    return res.status(200).json({ profiles: profiles.data || [], cvs: cvs.data || [] });
  } catch (err) {
    console.error('[admin-data]', err);
    return res.status(500).json({ error: err.message || 'Admin data error' });
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
