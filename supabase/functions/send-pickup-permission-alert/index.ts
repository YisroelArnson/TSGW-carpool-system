import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type QueueRow = {
  id: string;
  audit_id: string;
  authorization_id: string | null;
  action: "CREATED" | "UPDATED" | "REVOKED" | string;
  granting_family_id: string | null;
  receiving_family_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
  student_ids: string[] | null;
  status: string;
  attempt_count: number | null;
};

type FamilyRow = {
  id: string;
  carpool_number: number;
  parent_names: string | null;
  parent_one_first_name: string | null;
  parent_one_last_name: string | null;
  parent_two_first_name: string | null;
  parent_two_last_name: string | null;
  notification_email: string | null;
  notification_enabled: boolean | null;
};

type StudentRow = {
  id: string;
  first_name: string;
  last_name: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pickup-alert-secret",
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

function cleanText(value: unknown) {
  return String(value || "").trim();
}

function familyDisplayName(family: FamilyRow | null) {
  if (!family) return "Family";

  const parentOne = [family.parent_one_first_name, family.parent_one_last_name].map(cleanText).filter(Boolean).join(" ");
  const parentTwo = [family.parent_two_first_name, family.parent_two_last_name].map(cleanText).filter(Boolean).join(" ");
  if (parentOne && parentTwo) return `${parentOne} & ${parentTwo}`;
  if (parentOne) return parentOne;
  if (parentTwo) return parentTwo;
  return cleanText(family.parent_names) || `Family #${family.carpool_number}`;
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value: string | null) {
  if (!value || value === "9999-12-31") return "Permanent";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function actionCopy(action: string) {
  if (action === "UPDATED") {
    return {
      subject: "Pickup permission updated",
      headline: "Pickup permission updated",
      lead: "A pickup permission for your family was updated."
    };
  }
  if (action === "REVOKED") {
    return {
      subject: "Pickup permission revoked",
      headline: "Pickup permission revoked",
      lead: "A pickup permission for your family was revoked."
    };
  }
  return {
    subject: "Pickup permission granted",
    headline: "Pickup permission granted",
    lead: "A pickup permission was granted to your family."
  };
}

function extractQueueId(payload: Record<string, unknown>) {
  const record = payload.record as Record<string, unknown> | undefined;
  return cleanText(payload.queue_id || payload.id || record?.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const webhookSecret = Deno.env.get("PICKUP_ALERT_WEBHOOK_SECRET");
  if (webhookSecret) {
    const providedSecret = req.headers.get("x-pickup-alert-secret");
    const bearer = req.headers.get("authorization");
    if (providedSecret !== webhookSecret && bearer !== `Bearer ${webhookSecret}`) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("NOTIFICATION_FROM_EMAIL");
  const appBaseUrl = cleanText(Deno.env.get("APP_BASE_URL")).replace(/\/+$/, "");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase service configuration" }, 500);
  }
  if (!resendApiKey || !fromEmail) {
    return jsonResponse({ error: "Missing Resend email configuration" }, 500);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const queueId = extractQueueId(payload);
  if (!queueId) return jsonResponse({ error: "Missing queue id" }, 400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { data: currentQueue, error: currentError } = await supabase
    .from("pickup_notification_queue")
    .select("*")
    .eq("id", queueId)
    .maybeSingle<QueueRow>();

  if (currentError) return jsonResponse({ error: currentError.message }, 500);
  if (!currentQueue) return jsonResponse({ error: "Queue row not found" }, 404);
  if (["sent", "skipped"].includes(currentQueue.status)) {
    return jsonResponse({ ok: true, status: currentQueue.status });
  }

  const nextAttempt = (currentQueue.attempt_count || 0) + 1;
  const { data: queue, error: claimError } = await supabase
    .from("pickup_notification_queue")
    .update({
      status: "processing",
      attempt_count: nextAttempt,
      last_attempt_at: new Date().toISOString(),
      last_error: null
    })
    .eq("id", queueId)
    .in("status", ["pending", "failed"])
    .select("*")
    .maybeSingle<QueueRow>();

  if (claimError) return jsonResponse({ error: claimError.message }, 500);
  if (!queue) return jsonResponse({ ok: true, status: "already_processing" });

  async function markQueue(status: "sent" | "skipped" | "failed", details: Record<string, unknown>) {
    const payload = {
      status,
      ...details
    };
    await supabase
      .from("pickup_notification_queue")
      .update(payload)
      .eq("id", queue.id);
  }

  try {
    if (!queue.receiving_family_id) {
      await markQueue("skipped", { last_error: "Missing receiving family" });
      return jsonResponse({ ok: true, status: "skipped" });
    }

    const familyIds = [queue.granting_family_id, queue.receiving_family_id].filter(Boolean);
    const { data: families, error: familiesError } = await supabase
      .from("families")
      .select("id,carpool_number,parent_names,parent_one_first_name,parent_one_last_name,parent_two_first_name,parent_two_last_name,notification_email,notification_enabled")
      .in("id", familyIds);

    if (familiesError) throw familiesError;

    const familyById = new Map((families || []).map((family: FamilyRow) => [family.id, family]));
    const grantingFamily = queue.granting_family_id ? familyById.get(queue.granting_family_id) || null : null;
    const receivingFamily = familyById.get(queue.receiving_family_id) || null;

    if (!receivingFamily) {
      await markQueue("skipped", { last_error: "Receiving family not found" });
      return jsonResponse({ ok: true, status: "skipped" });
    }
    if (receivingFamily.notification_enabled === false) {
      await markQueue("skipped", { last_error: "Receiving family notifications are disabled" });
      return jsonResponse({ ok: true, status: "skipped" });
    }
    if (!cleanText(receivingFamily.notification_email)) {
      await markQueue("skipped", { last_error: "Receiving family has no notification email" });
      return jsonResponse({ ok: true, status: "skipped" });
    }

    const studentIds = queue.student_ids || [];
    const { data: students, error: studentsError } = studentIds.length
      ? await supabase
        .from("students")
        .select("id,first_name,last_name")
        .in("id", studentIds)
      : { data: [], error: null };

    if (studentsError) throw studentsError;

    const studentNames = ((students || []) as StudentRow[])
      .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
      .map((student) => `${student.first_name} ${student.last_name}`);

    const copy = actionCopy(queue.action);
    const grantingName = familyDisplayName(grantingFamily);
    const receivingName = familyDisplayName(receivingFamily);
    const dateText = queue.ends_on === "9999-12-31"
      ? `Starts ${formatDate(queue.starts_on)}. No end date.`
      : `${formatDate(queue.starts_on)} to ${formatDate(queue.ends_on)}`;
    const settingsUrl = appBaseUrl ? `${appBaseUrl}/settings/` : "";
    const studentText = studentNames.length ? studentNames.join(", ") : "No students listed";

    const text = [
      copy.lead,
      "",
      `Receiving family: ${receivingName}`,
      `Granting family: ${grantingName}`,
      `Students: ${studentText}`,
      `Dates: ${dateText}`,
      settingsUrl ? `View settings: ${settingsUrl}` : ""
    ].filter(Boolean).join("\n");

    const html = `
      <div style="font-family: Arial, sans-serif; color: #2B2B2B; line-height: 1.5;">
        <h1 style="font-size: 20px; margin: 0 0 12px;">${escapeHtml(copy.headline)}</h1>
        <p>${escapeHtml(copy.lead)}</p>
        <table style="border-collapse: collapse; margin-top: 16px;">
          <tr><td style="font-weight: 700; padding: 4px 12px 4px 0;">Receiving family</td><td>${escapeHtml(receivingName)}</td></tr>
          <tr><td style="font-weight: 700; padding: 4px 12px 4px 0;">Granting family</td><td>${escapeHtml(grantingName)}</td></tr>
          <tr><td style="font-weight: 700; padding: 4px 12px 4px 0;">Students</td><td>${escapeHtml(studentText)}</td></tr>
          <tr><td style="font-weight: 700; padding: 4px 12px 4px 0;">Dates</td><td>${escapeHtml(dateText)}</td></tr>
        </table>
        ${settingsUrl ? `<p style="margin-top: 18px;"><a href="${escapeHtml(settingsUrl)}">View carpool settings</a></p>` : ""}
      </div>
    `;

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [receivingFamily.notification_email],
        subject: copy.subject,
        html,
        text
      })
    });

    const resendBody = await resendResponse.json().catch(() => ({}));
    if (!resendResponse.ok) {
      const message = cleanText((resendBody as Record<string, unknown>).message) || `Resend returned ${resendResponse.status}`;
      throw new Error(message);
    }

    await markQueue("sent", {
      sent_at: new Date().toISOString(),
      provider_message_id: cleanText((resendBody as Record<string, unknown>).id) || null,
      last_error: null
    });

    return jsonResponse({ ok: true, status: "sent" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send notification";
    await markQueue("failed", { last_error: message });
    return jsonResponse({ error: message }, 500);
  }
});
