/**
 * CV Central — CV Version Manager API
 * GET    /api/cv-versions          — list versions (newest first)
 * POST   /api/cv-versions          — save new version
 * DELETE /api/cv-versions?id=<id>  — delete version
 * Requires: Pro, Premium, or active day_pass
 */
const { authenticate } = require('./_auth');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';
const ALLOWED_PLANS = ['pro', 'premium', 'day_pass'];

async function sb(path, opts) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({
    headers: Object.assign({ apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' }, (opts && opts.headers) || {})
  }, opts));
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch(e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let auth;
  try { auth = await authenticate(req); } catch(e) { return res.status(e.status || 401).json({ error: e.message }); }
  if (!ALLOWED_PLANS.includes(auth.plan)) return res.status(403).json({ error: 'CV Version Manager requires a Pro plan.' });

  const userId = auth.userId;

  if (req.method === 'GET') {
    const { ok, data } = await sb('cv_versions?user_id=eq.' + userId + '&order=created_at.desc&select=id,name,created_at');
    if (!ok) return res.status(500).json({ error: 'Could not fetch versions' });
    return res.status(200).json({ versions: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    const { name, cv_data } = req.body || {};
    if (!cv_data) return res.status(400).json({ error: 'cv_data is required' });
    const { ok, data } = await sb('cv_versions', { method: 'POST', body: JSON.stringify({ user_id: userId, name: (name || 'Version').slice(0, 100), cv_data }) });
    if (!ok) return res.status(500).json({ error: 'Could not save version' });
    return res.status(201).json({ version: Array.isArray(data) ? data[0] : data });
  }

  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { ok } = await sb('cv_versions?id=eq.' + id + '&user_id=eq.' + userId, { method: 'DELETE', headers: { Prefer: '' } });
    if (!ok) return res.status(500).json({ error: 'Could not delete version' });
    return res.status(200).json({ ok: true });
  }

  // GET full version data
  if (req.method === 'GET' && req.query && req.query.id) {
    const { ok, data } = await sb('cv_versions?id=eq.' + req.query.id + '&user_id=eq.' + userId + '&select=*');
    if (!ok || !data || !data[0]) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ version: data[0] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
