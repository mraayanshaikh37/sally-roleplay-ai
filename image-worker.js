/* =================================================
   IMAGE WORKER — talks to Mistral (Pixtral) only.
   Returns a plain-text description of the image(s).
   Needs one secret: MISTRAL_API_KEY

   Expected request body:
   { "text": "optional user context", "images": [{ "type": "image/jpeg", "base64": "..." }] }

   Response:
   { "description": "..." }
   ================================================= */

const MISTRAL_URL =
  "https://api.mistral.ai/v1/chat/completions";

const MISTRAL_VISION_MODEL =
  "pixtral-12b-2409";

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

async function describeImagesWithPixtral(images, userText, env) {

  const promptText = userText && userText.length > 0
    ? `Analyze the attached image(s) carefully.

The user also wrote:
"${userText}"

Understand the image(s) and extract all information relevant to the
user's request. If there is visible text, read and transcribe it
accurately. Describe diagrams, layout, people, objects, mood, and
setting in specific detail.

Do not invent information that is not visible in the image.`
    : `Analyze the attached image(s) carefully.

Describe them in specific detail — objects, people, text, diagrams,
mood, and setting. If there is visible text, read and transcribe it
accurately.

Do not invent information that is not visible in the image.`;

  const content = [
    { type: "text", text: promptText }
  ];

  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.type};base64,${img.base64}` }
    });
  }

  const response = await fetch(MISTRAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${String(env.MISTRAL_API_KEY).trim()}`
    },
    body: JSON.stringify({
      model: MISTRAL_VISION_MODEL,
      messages: [
        { role: "user", content }
      ],
      temperature: 0.1,
      max_tokens: 2000
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `Pixtral request failed (${response.status})`;
    throw new Error(message);
  }

  let description = data?.choices?.[0]?.message?.content;

  if (Array.isArray(description)) {
    description = description.map(part => part.text || "").join("\n");
  }

  description = String(description || "").trim();

  if (!description) {
    throw new Error("Pixtral returned an empty description.");
  }

  return description;
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
        const r = await fetch(MISTRAL_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${String(env.MISTRAL_API_KEY || "").trim()}`
          },
          body: JSON.stringify({
            model: MISTRAL_VISION_MODEL,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 20
          })
        });
        const text = await r.text();
        return new Response(JSON.stringify({
          status: r.status,
          ok: r.ok,
          keyPresent: !!env.MISTRAL_API_KEY,
          keyPrefix: env.MISTRAL_API_KEY ? String(env.MISTRAL_API_KEY).slice(0, 6) + "..." : null,
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

    if (!env.MISTRAL_API_KEY) {
      return json({ error: "MISTRAL_API_KEY secret is not set on this Worker." }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json({ error: "Invalid JSON body." }, 400, origin);
    }

    const images = body?.images;

    if (!Array.isArray(images) || images.length === 0) {
      return json({ error: "Missing 'images' array." }, 400, origin);
    }

    try {
      const description = await describeImagesWithPixtral(
        images,
        body.text || "",
        env
      );
      return json({ description }, 200, origin);
    } catch (err) {
      return json(
        { error: `Image processing failed: ${err.message}` },
        502,
        origin
      );
    }
  }
};
