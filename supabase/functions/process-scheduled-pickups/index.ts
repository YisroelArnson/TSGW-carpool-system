import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-scheduled-pickup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const scheduledSecret = Deno.env.get("SCHEDULED_PICKUP_SECRET");
  if (!scheduledSecret) {
    return jsonResponse({ error: "Missing scheduled pickup secret configuration" }, 500);
  }

  const providedSecret = req.headers.get("x-scheduled-pickup-secret");
  const bearer = req.headers.get("authorization");
  if (providedSecret !== scheduledSecret && bearer !== `Bearer ${scheduledSecret}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase service configuration" }, 500);
  }

  let limit = 25;
  try {
    const payload = await req.json();
    const requestedLimit = Number(payload?.limit);
    if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
      limit = Math.min(Math.floor(requestedLimit), 100);
    }
  } catch (_error) {
    // A scheduler may send an empty body. Use the default limit.
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { data, error } = await supabase.rpc("process_due_scheduled_pickup_requests", {
    p_limit: limit
  });

  if (error) return jsonResponse({ error: error.message }, 500);
  return jsonResponse({ ok: true, ...data });
});
