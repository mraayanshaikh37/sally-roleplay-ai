/* =================================================
   CHAT WORKER — text-only, talks to NVIDIA only.
   Needs one secret: NVIDIA_API_KEY
   ================================================= */

const NVIDIA_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";

const NVIDIA_MODEL =
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

/* =================================================
   ALLOWED ORIGINS
   ================================================= */

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/mraayanshaikh37\.github\.io$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^null$/
];

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin));
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin":
      isAllowedOrigin(origin) ? origin : "null",
    "Access-Control-Allow-Methods":
      "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type",
    "Access-Control-Max-Age":
      "86400",
    "Vary":
      "Origin"
  };
}

function json(data, status, origin) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...cors(origin)
      }
    }
  );
}

async function callNvidia(messages, temperature, maxTokens, env) {

  const response = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${String(env.NVIDIA_API_KEY).trim()}`
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 1200
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `NVIDIA request failed (${response.status})`;
    throw new Error(message);
  }

  return data;
}

export default {

  async fetch(request, env) {

    const origin =
      request.headers.get("Origin") || "";

    const url = new URL(request.url);

    /* ---------- TEMPORARY DIAGNOSTIC ROUTE ----------
       Visit: <this-worker-url>/diag  (plain GET)
       REMOVE once you've confirmed the key works. */
    if (request.method === "GET" && url.pathname === "/diag") {

      try {
        const r = await fetch(NVIDIA_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${String(env.NVIDIA_API_KEY || "").trim()}`
          },
          body: JSON.stringify({
            model: NVIDIA_MODEL,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 20
          })
        });
        const text = await r.text();
        return new Response(JSON.stringify({
          status: r.status,
          ok: r.ok,
          keyPresent: !!env.NVIDIA_API_KEY,
          keyPrefix: env.NVIDIA_API_KEY ? String(env.NVIDIA_API_KEY).slice(0, 6) + "..." : null,
          body: text.slice(0, 300)
        }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(origin)
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: cors(origin)
      });
    }

    if (!isAllowedOrigin(origin)) {
      return new Response("Forbidden", {
        status: 403,
        headers: cors(origin)
      });
    }

    if (!env.NVIDIA_API_KEY) {
      return json({ error: "NVIDIA_API_KEY secret is not set on this Worker." }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json({ error: "Invalid JSON body." }, 400, origin);
    }

    const messages = body?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Missing 'messages' array." }, 400, origin);
    }

    try {
      const nvidiaData = await callNvidia(
        messages,
        body.temperature,
        body.max_tokens,
        env
      );
      return json(nvidiaData, 200, origin);
    } catch (err) {
      return json(
        { error: `NVIDIA request failed: ${err.message}` },
        502,
        origin
      );
    }
  }
};
