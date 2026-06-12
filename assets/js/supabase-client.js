(function initSupabaseClient() {
  const config = window.CARPOOL_CONFIG || {};
  const hasConfig = config.supabaseUrl && config.supabaseAnonKey;

  if (!window.supabase || !hasConfig) {
    window.carpoolClient = null;
    return;
  }

  function authStorageKey() {
    const portalPathParts = ["admin", "classroom", "spotter", "parent", "settings"];
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    const portalPathPart = pathParts.find((part) => portalPathParts.includes(part)) || "parent";
    const portal = portalPathPart === "settings" ? "parent" : portalPathPart;
    const scopedPortal = ["admin", "classroom", "spotter", "parent"].includes(portal) ? portal : "parent";
    let projectRef = "default";
    try {
      projectRef = new URL(config.supabaseUrl).hostname.split(".")[0] || projectRef;
    } catch (_error) {
      projectRef = "default";
    }
    return `tsgw-carpool-auth-${projectRef}-${scopedPortal}`;
  }

  window.carpoolClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      storageKey: authStorageKey(),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
})();
