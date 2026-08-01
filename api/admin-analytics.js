/**
 * CV Central — Admin Analytics API (Vercel Serverless)
 *
 * Reads the analytics_events table (see migration "create_analytics_events_table")
 * with the service-role key and returns aggregated funnel + daily-activity
 * numbers for the admin dashboard. Same x-admin-key gate as
 * api/admin-feedback.js and api/admin-data.js — no client ever reads
 * analytics_events directly (its RLS policy only allows INSERT).
 *
 * Method: GET /api/admin-analytics
 * Auth:   header  x-admin-key: <ADMIN_PASSWORD>
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://exzkmavkzqknoghopwhq.supabase.co';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CVCentral2026!';

// Ordered so the funnel reads top-to-bottom as the real user journey.
const FUNNEL_STEPS = [
  { key: 'signup_completed',    label: 'Signed up' },
  { key: 'login_completed',     label: 'Logged in' },
  { key: 'builder_opened',      label: 'Opened CV builder' },
  { key: 'reached_final_step',  label: 'Reached final step (review)' },
  { key: 'ai_analysis_started', label: 'Started AI analysis' },
  { key: 'ai_analysis_completed', label: 'AI analysis completed' },
  { key: 'cv_saved',            label: 'Saved a CV' },
  { key: 'pdf_downloaded',      label: 'Downloaded PDF' }
];

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
    // Last 5000 events is comfortably more than a 50-100 person test cohort
    // will generate for a long while — no need for date-range pagination yet.
    const result = await supabaseQuery(
      'analytics_events?select=event_name,session_id,user_id,meta,created_at&order=created_at.desc&limit=5000'
    );
    if (!result.ok) return res.status(result.status).json({ error: result.data });
    const events = result.data || [];

    // Distinct sessions per funnel event (a session doing the same thing
    // twice only counts once — funnel counts should answer "how many
    // people got this far", not "how many times did this fire").
    const sessionsByEvent = {};
    events.forEach(function (e) {
      var effectiveName = e.event_name;
      if (e.event_name === 'wizard_step_reached' && e.meta && e.meta.step >= 5) {
        effectiveName = 'reached_final_step';
      }
      if (!sessionsByEvent[effectiveName]) sessionsByEvent[effectiveName] = new Set();
      sessionsByEvent[effectiveName].add(e.session_id);
    });

    const funnel = FUNNEL_STEPS.map(function (step) {
      return {
        event: step.key,
        label: step.label,
        sessions: sessionsByEvent[step.key] ? sessionsByEvent[step.key].size : 0
      };
    });

    const allSessions = new Set(events.map(function (e) { return e.session_id; }));
    const allUsers = new Set(events.filter(function (e) { return e.user_id; }).map(function (e) { return e.user_id; }));

    // Daily event counts, last 14 days
    const dailyMap = {};
    var today = new Date();
    for (var i = 13; i >= 0; i--) {
      var d = new Date(today.getTime() - i * 86400000);
      dailyMap[d.toISOString().slice(0, 10)] = 0;
    }
    events.forEach(function (e) {
      var day = (e.created_at || '').slice(0, 10);
      if (dailyMap[day] !== undefined) dailyMap[day]++;
    });
    const daily = Object.keys(dailyMap).sort().map(function (day) {
      return { date: day, count: dailyMap[day] };
    });

    return res.status(200).json({
      totalEvents: events.length,
      uniqueSessions: allSessions.size,
      uniqueUsers: allUsers.size,
      funnel: funnel,
      daily: daily
    });
  } catch (err) {
    console.error('[admin-analytics]', err);
    return res.status(500).json({ error: err.message || 'Admin analytics error' });
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
