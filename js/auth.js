/* CV Central — shared Supabase Auth client
   Requires: supabase-js CDN loaded before this file */

(function () {
  'use strict';

  var SUPABASE_URL = 'https://exzkmavkzqknoghopwhq.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4emttYXZrenFrbm9naG9wd2hxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NjI5MjMsImV4cCI6MjA5ODMzODkyM30.ZiQSoZ2bTErHX-zHa6QQ-P2TD5eNgoPfB--Bpnk9R5I';

  var _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, detectSessionInUrl: true }
  });

  window.cvAuth = {
    client: _client,

    getSession: async function () {
      var res = await _client.auth.getSession();
      return res.data.session;
    },

    getUser: async function () {
      var res = await _client.auth.getUser();
      return res.data.user;
    },

    /* Redirect to login.html if there is no active session.
       Returns the session object if authenticated, null otherwise. */
    requireAuth: async function (redirect) {
      var session = await this.getSession();
      if (!session) {
        window.location.href = redirect || 'login.html';
        return null;
      }
      return session;
    },

    signOut: async function () {
      await _client.auth.signOut();
      window.location.href = 'login.html';
    },

    getProfile: async function (userId) {
      var res = await _client
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      return res.data;
    },

    /* Save CV data to saved_cvs, upsert on user_id + cv_name.
       Returns { data, error } */
    saveCV: async function (userId, cvData, template, colorScheme, cvName, score) {
      return _client
        .from('saved_cvs')
        .upsert({
          user_id: userId,
          cv_name: cvName || 'My CV',
          cv_data: cvData,
          template: template || 'professional',
          color_scheme: colorScheme || null,
          score: score || null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,cv_name' });
    }
  };
})();
