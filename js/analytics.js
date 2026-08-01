/* CV Central — minimal first-party analytics
   Requires: supabase-js CDN + js/auth.js loaded before this file (uses
   cvAuth.client, the same anon-key Supabase client already on every page —
   no new script tag needed).

   Why this exists: before this, there was no way to see where people
   dropped off in the CV builder wizard, whether AI analysis was actually
   being used, or how many people who started ever saved a CV. This logs a
   small set of funnel events to a Supabase table (write-only from the
   client — same RLS pattern as the feedback table) so the admin dashboard
   can show real numbers instead of just qualitative feedback-form text.

   Deliberately NOT a general page-view tracker — every event here maps to
   one specific, useful question about the CV-building funnel. Add more
   only when there's a real question to answer with them.
*/
(function () {
  'use strict';

  var SESSION_KEY = 'cvc_analytics_sid';

  function getSessionId() {
    try {
      var sid = localStorage.getItem(SESSION_KEY);
      if (!sid) {
        sid = 'sid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(SESSION_KEY, sid);
      }
      return sid;
    } catch (e) {
      // localStorage unavailable (private browsing etc.) — fall back to a
      // per-page-load id rather than losing the event entirely.
      return 'sid_nopersist_' + Math.random().toString(36).slice(2, 10);
    }
  }

  async function track(eventName, meta) {
    try {
      if (typeof cvAuth === 'undefined' || !cvAuth.client) return;
      var userId = null;
      try {
        var session = await cvAuth.getSession();
        if (session && session.user) userId = session.user.id;
      } catch (e) { /* not signed in — that's fine, events work for guests too */ }

      await cvAuth.client.from('analytics_events').insert({
        event_name: eventName,
        session_id: getSessionId(),
        user_id: userId,
        page: window.location.pathname,
        meta: meta || null
      });
    } catch (e) {
      // Analytics must never break the product. Swallow silently.
      console.warn('[analytics] track failed:', eventName, e && e.message);
    }
  }

  window.cvTrack = track;
})();
