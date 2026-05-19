export default async function handler(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  const functionUrl = process.env.SCHEDULED_PICKUP_FUNCTION_URL;
  const scheduledPickupSecret = process.env.SCHEDULED_PICKUP_SECRET;

  if (!cronSecret || !functionUrl || !scheduledPickupSecret) {
    return response.status(500).json({
      error: "Missing scheduled pickup environment configuration"
    });
  }

  if (request.headers.authorization !== `Bearer ${cronSecret}`) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const upstreamResponse = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-scheduled-pickup-secret": scheduledPickupSecret
    },
    body: JSON.stringify({ limit: 25 })
  });

  const upstreamText = await upstreamResponse.text();
  let upstreamBody;

  try {
    upstreamBody = upstreamText ? JSON.parse(upstreamText) : {};
  } catch (_error) {
    upstreamBody = { body: upstreamText };
  }

  if (!upstreamResponse.ok) {
    return response.status(502).json({
      error: "Scheduled pickup processor failed",
      status: upstreamResponse.status,
      details: upstreamBody
    });
  }

  return response.status(200).json({
    ok: true,
    processor: upstreamBody
  });
}
