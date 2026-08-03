/**
 * CV Central — Saved Cover Letters API
 * GET    /api/cover-letters          — list (newest first)
 * POST   /api/cover-letters          — save new
 * DELETE /api/cover-letters?id=<id>  — delete
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
  if (!ALLOWED_PLANS.includes(auth.plan)) return res.status(403).json({ error: 'Saving cover letters requires a Pro plan.' });

  const userId = auth.userId;

  if (req.method === 'GET') {
    const { ok, data } = await sb('saved_cover_letters?user_id=eq.' + userId + '&order=created_at.desc&select=*');
    if (!ok) return res.status(500).json({ error: 'Could not fetch cover letters' });
    return res.status(200).json({ coverLetters: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.content) return res.status(400).json({ error: 'content is required' });
    const row = {
      user_id:  userId,
      title:    (body.title || 'Cover Letter').slice(0, 150),
      content:  body.content,
      job_title: (body.job_title || '').slice(0, 150),
      company:  (body.company || '').slice(0, 150),
      language: (body.language || 'English').slice(0, 50)
    };
    const { ok, data } = await sb('saved_cover_letters', { method: 'POST', body: JSON.stringify(row) });
    if (!ok) return res.status(500).json({ error: 'Could not save cover letter' });
    return res.status(201).json({ coverLetter: Array.isArray(data) ? data[0] : data });
  }

  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { ok } = await sb('saved_cover_letters?id=eq.' + id + '&user_id=eq.' + userId, { method: 'DELETE', headers: { Prefer: '' } });
    if (!ok) return res.status(500).json({ error: 'Could not delete' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
