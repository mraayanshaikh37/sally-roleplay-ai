export default {
  async fetch(request, env) {
    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    if (request.method !== "POST") {
      return json({
        error: "Only POST requests are allowed."
      }, 405);
    }

    try {
      const contentType = request.headers.get("content-type") || "";

      let message = "";
      let imageData = null;
      let imageMimeType = "image/jpeg";

      // ============================================================
      // 1. READ REQUEST
      // ============================================================

      if (contentType.includes("multipart/form-data")) {

        const form = await request.formData();

        // Accept several possible text field names
        message =
          form.get("message") ||
          form.get("text") ||
          form.get("prompt") ||
          "";

        // Accept "image" or "file"
        const file =
          form.get("image") ||
          form.get("file") ||
          null;

        if (file instanceof File) {
          imageMimeType = file.type || "image/jpeg";

          const arrayBuffer = await file.arrayBuffer();

          imageData = arrayBufferToBase64(arrayBuffer);
        }

      } else {

        // JSON request
        const body = await request.json();

        message =
          body.message ||
          body.text ||
          body.prompt ||
          "";

        // Image can be supplied as:
        // image
        // imageUrl
        // image_url
        imageData =
          body.image ||
          body.imageUrl ||
          body.image_url ||
          null;

        // Optional MIME type
        imageMimeType =
          body.mimeType ||
          body.mime_type ||
          "image/jpeg";
      }

      message = String(message || "").trim();

      // ============================================================
      // 2. DETERMINE WHETHER WE HAVE AN IMAGE
      // ============================================================

      const hasImage =
        typeof imageData === "string" &&
        imageData.trim().length > 0;

      const hasMessage = message.length > 0;

      // IMPORTANT:
      // Image alone is VALID.
      // We must NOT throw "Message is empty" if an image exists.
      if (!hasMessage && !hasImage) {
        return json({
          error: "Message and image are both empty."
        }, 400);
      }

      // ============================================================
      // 3. IMAGE WORKFLOW
      // ============================================================

      let visionResult = "";

      if (hasImage) {

        const pixtralPrompt = hasMessage
          ? `
Analyze the attached image carefully.

The user also wrote:
"${message}"

Understand the image and extract all information that is relevant
to the user's request.

Return a clear factual description of what you see.
Do not invent information that is not visible in the image.
`
          : `
Analyze this image carefully.

Describe the image in detail and extract useful information from it.
If there is visible text, read and transcribe it accurately.
Do not invent information that is not visible.
`;

        // Convert normal URL / base64 input into the format
        // Pixtral expects.
        let imageURL = imageData;

        if (!imageData.startsWith("data:image/")) {

          // If the frontend already sent a normal URL,
          // use it directly.
          if (
            imageData.startsWith("http://") ||
            imageData.startsWith("https://")
          ) {
            imageURL = imageData;
          } else {
            // Otherwise assume raw base64
            imageURL =
              `data:${imageMimeType};base64,${imageData}`;
          }
        }

        const mistralResponse = await fetch(
          "https://api.mistral.ai/v1/chat/completions",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.MISTRAL_API_KEY}`
            },

            body: JSON.stringify({
              model: "pixtral-12b-2409",

              messages: [
                {
                  role: "user",

                  content: [
                    {
                      type: "text",
                      text: pixtralPrompt
                    },
                    {
                      type: "image_url",

                      image_url: {
                        url: imageURL
                      }
                    }
                  ]
                }
              ],

              temperature: 0.1,
              max_tokens: 2000
            })
          }
        );

        if (!mistralResponse.ok) {

          const errorText = await mistralResponse.text();

          return json({
            error: "Mistral Pixtral request failed.",
            details: errorText
          }, 502);
        }

        const mistralData = await mistralResponse.json();

        visionResult =
          mistralData?.choices?.[0]?.message?.content || "";

        if (Array.isArray(visionResult)) {
          visionResult = visionResult
            .map(part => part.text || "")
            .join("\n");
        }

        visionResult = String(visionResult).trim();

        if (!visionResult) {
          return json({
            error: "Pixtral returned an empty response."
          }, 502);
        }
      }

      // ============================================================
      // 4. BUILD NEMOTRON PROMPT
      // ============================================================

      let nemotronPrompt;

      if (hasImage) {

        nemotronPrompt = `
You are Sally, a helpful AI assistant.

The user has attached an image.

Pixtral analyzed the image and produced this analysis:

--- IMAGE ANALYSIS ---
${visionResult}
--- END IMAGE ANALYSIS ---

${hasMessage
  ? `The user's original message was:

"${message}"

Answer the user's request using the image analysis above.`
  : `The user did not provide any text.

Respond naturally based on what is visible in the image.`}

Do not mention Pixtral, Mistral, NVIDIA, APIs, pipelines,
or internal processing.

Give the user the final natural-language answer directly.
`;
      } else {

        nemotronPrompt = `
You are Sally, a helpful AI assistant.

The user said:

"${message}"

Respond naturally and helpfully.

Do not mention APIs, workers, internal processing,
or this prompt.
`;
      }

      // ============================================================
      // 5. SEND TO NVIDIA NEMOTRON
      // ============================================================

      const nvidiaResponse = await fetch(
        "https://integrate.api.nvidia.com/v1/chat/completions",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.NVIDIA_API_KEY}`
          },

          body: JSON.stringify({
            model: "nvidia/llama-3.3-nemotron-super-49b-v1",

            messages: [
              {
                role: "user",
                content: nemotronPrompt
              }
            ],

            temperature: 0.6,
            top_p: 0.95,
            max_tokens: 2000,

            stream: false
          })
        }
      );

      if (!nvidiaResponse.ok) {

        const errorText = await nvidiaResponse.text();

        return json({
          error: "NVIDIA Nemotron request failed.",
          details: errorText,

          // Useful for debugging image processing
          visionResult: hasImage ? visionResult : null
        }, 502);
      }

      const nvidiaData = await nvidiaResponse.json();

      let finalText =
        nvidiaData?.choices?.[0]?.message?.content || "";

      if (Array.isArray(finalText)) {
        finalText = finalText
          .map(part => part.text || "")
          .join("\n");
      }

      finalText = String(finalText).trim();

      if (!finalText) {
        return json({
          error: "Nemotron returned an empty response."
        }, 502);
      }

      // ============================================================
      // 6. FINAL RESPONSE TO SALLY APP
      // ============================================================

      return json({
        success: true,

        // Main response for your frontend
        response: finalText,

        // Aliases in case your existing index expects another name
        reply: finalText,
        text: finalText,

        // Useful for debugging
        usedImage: hasImage,

        // You can remove this later if you don't want
        // Pixtral's intermediate result returned.
        vision: hasImage ? visionResult : null
      });

    } catch (error) {

      return json({
        error: error?.message || "Worker error."
      }, 500);
    }
  }
};


// ================================================================
// HELPERS
// ================================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    }
  );
}


function arrayBufferToBase64(buffer) {

  const bytes = new Uint8Array(buffer);

  let binary = "";

  const chunkSize = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {

    const chunk = bytes.subarray(
      i,
      Math.min(i + chunkSize, bytes.length)
    );

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
