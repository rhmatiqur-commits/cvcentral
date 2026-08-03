/**
 * CV Central — Application Tracker API (Vercel serverless)
 *
 * GET    /api/tracker              — list user's applications
 * POST   /api/tracker              — create application
 * PATCH  /api/tracker?id=<uuid>    — update application
 * DELETE /api/tracker?id=<uuid>    — delete application
 *
 * Requires: Pro or Premium plan (or active day_pass).
 */

const { authenticate } = require('./_auth');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';

async function supabase(path, opts) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({
    headers: Object.assign({
      apikey:        process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer:        'return=representation'
    }, opts && opts.headers ? opts.headers : {})
  }, opts));
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

const ALLOWED_PLANS = ['pro', 'premium', 'day_pass'];

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let auth;
  try { auth = await authenticate(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (!ALLOWED_PLANS.includes(auth.plan)) {
    return res.status(403).json({ error: 'Application Tracker requires a Pro or Premium plan.' });
  }

  const userId = auth.userId;
  const appId  = req.query && req.query.id;

  // ── GET — list ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { ok, data } = await supabase(
      'applications?user_id=eq.' + userId + '&order=created_at.desc&select=*'
    );
    if (!ok) return res.status(500).json({ error: 'Could not fetch applications' });
    return res.status(200).json({ applications: Array.isArray(data) ? data : [] });
  }

  // ── POST — create ────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const row = {
      user_id:      userId,
      company:      (body.company || '').trim(),
      role:         (body.role || '').trim(),
      status:       body.status || 'applied',
      applied_date: body.applied_date || null,
      url:          body.url || null,
      notes:        body.notes || null,
      cv_id:        body.cv_id || null
    };
    if (!row.company && !row.role) {
      return res.status(400).json({ error: 'Company or role is required' });
    }
    const { ok, data } = await supabase('applications', {
      method: 'POST',
      body: JSON.stringify(row)
    });
    if (!ok) return res.status(500).json({ error: 'Could not create application' });
    return res.status(201).json({ application: Array.isArray(data) ? data[0] : data });
  }

  // ── PATCH — update ───────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    if (!appId) return res.status(400).json({ error: 'id is required' });
    const body = req.body || {};
    const allowed = ['company', 'role', 'status', 'applied_date', 'url', 'notes', 'cv_id'];
    const patch = {};
    allowed.forEach(function(k) { if (body[k] !== undefined) patch[k] = body[k]; });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    const { ok, data } = await supabase(
      'applications?id=eq.' + appId + '&user_id=eq.' + userId,
      { method: 'PATCH', body: JSON.stringify(patch) }
    );
    if (!ok) return res.status(500).json({ error: 'Could not update application' });
    return res.status(200).json({ application: Array.isArray(data) ? data[0] : data });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!appId) return res.status(400).json({ error: 'id is required' });
    const { ok } = await supabase(
      'applications?id=eq.' + appId + '&user_id=eq.' + userId,
      { method: 'DELETE', headers: { Prefer: '' } }
    );
    if (!ok) return res.status(500).json({ error: 'Could not delete application' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
