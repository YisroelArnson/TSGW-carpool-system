(function initSupabaseClient() {
  const config = window.CARPOOL_CONFIG || {};
  const hasConfig = config.supabaseUrl && config.supabaseAnonKey;

  if (!window.supabase || !hasConfig) {
    window.carpoolClient = null;
    return;
  }

  window.carpoolClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
})();
