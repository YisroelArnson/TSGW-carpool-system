type HelpRequestPayload = {
  name?: string;
  familyNumber?: string;
  contact?: string;
  question?: string;
  website?: string;
  pageUrl?: string;
  userAgent?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

function cleanText(value: unknown, maxLength = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanLongText(value: unknown, maxLength = 3000) {
  return String(value || "").trim().slice(0, maxLength);
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function possibleEmail(value: string) {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("NOTIFICATION_FROM_EMAIL");
  const officeEmail = Deno.env.get("OFFICE_HELP_EMAIL") || "info@tsgw.org";

  if (!resendApiKey || !fromEmail) {
    return jsonResponse({ error: "Missing Resend email configuration" }, 500);
  }

  let payload: HelpRequestPayload;
  try {
    payload = await req.json();
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (cleanText(payload.website)) {
    return jsonResponse({ ok: true });
  }

  const name = cleanText(payload.name, 100);
  const familyNumber = cleanText(payload.familyNumber, 20);
  const contact = cleanText(payload.contact, 200);
  const question = cleanLongText(payload.question, 3000);
  const pageUrl = cleanText(payload.pageUrl, 500);
  const userAgent = cleanText(payload.userAgent, 500);

  if (!question) {
    return jsonResponse({ error: "Question is required" }, 400);
  }

  const subjectName = name || (familyNumber ? `Family #${familyNumber}` : "Parent");
  const subject = `TSGW Carpool help question from ${subjectName}`;
  const textBody = [
    "A parent submitted a carpool help question.",
    "",
    `Name: ${name || "Not provided"}`,
    `Family Number: ${familyNumber || "Not provided"}`,
    `Contact: ${contact || "Not provided"}`,
    "",
    "Question:",
    question,
    "",
    `Page: ${pageUrl || "Not provided"}`,
    `User Agent: ${userAgent || "Not provided"}`
  ].join("\n");

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;color:#222;line-height:1.5">
      <h2 style="margin:0 0 12px">TSGW Carpool help question</h2>
      <p><strong>Name:</strong> ${escapeHtml(name || "Not provided")}</p>
      <p><strong>Family Number:</strong> ${escapeHtml(familyNumber || "Not provided")}</p>
      <p><strong>Contact:</strong> ${escapeHtml(contact || "Not provided")}</p>
      <h3 style="margin:20px 0 8px">Question</h3>
      <p style="white-space:pre-wrap">${escapeHtml(question)}</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:20px 0" />
      <p><strong>Page:</strong> ${escapeHtml(pageUrl || "Not provided")}</p>
      <p><strong>User Agent:</strong> ${escapeHtml(userAgent || "Not provided")}</p>
    </div>
  `;

  const resendPayload: Record<string, unknown> = {
    from: fromEmail,
    to: [officeEmail],
    subject,
    text: textBody,
    html: htmlBody
  };

  const replyTo = possibleEmail(contact);
  if (replyTo) {
    resendPayload.reply_to = replyTo;
  }

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(resendPayload)
  });

  const resendBody = await resendResponse.json().catch(() => ({}));
  if (!resendResponse.ok) {
    const message = cleanText((resendBody as Record<string, unknown>).message) || `Resend returned ${resendResponse.status}`;
    return jsonResponse({ error: message }, 502);
  }

  return jsonResponse({ ok: true, id: (resendBody as Record<string, unknown>).id || null });
});
