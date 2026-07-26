/**
 * routes/ai.js
 */

const express = require("express");
const router  = express.Router();

const GROQ_KEY   = process.env.GROQ_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `You are a senior software engineer and coding assistant embedded inside a collaborative code editor called Hybridscript.
Keep responses concise.`;

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite"
];

// ── POST /ai/chat ─────────────────────────
router.post("/chat", async (req, res) => {
  const { message, context, history = [] } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ success: false, message: "message is required" });
  }

  if (!GROQ_KEY && !GEMINI_KEY) {
    return res.status(503).json({
      success: false,
      message: "No AI API keys configured",
    });
  }

  const userContent = context
    ? `${message}\n\n${context.slice(0, 2000)}`
    : message;

  if (GROQ_KEY) {
    try {
      const reply = await _callGroq(userContent, history);
      return res.json({ success: true, reply, provider: "groq" });
    } catch (err) {
      console.warn("Groq failed, trying Gemini:", err.message);
    }
  }

  if (GEMINI_KEY) {
    try {
      const reply = await _callGemini(userContent, history);
      return res.json({ success: true, reply, provider: "gemini" });
    } catch (err) {
      console.error("Gemini failed:", err.message);
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  return res.status(503).json({ success: false });
});


// ── Groq ─────────────────────────
async function _callGroq(userMessage, history) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + GROQ_KEY,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages,
      max_tokens: 1024,
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "(no response)";
}

// ── Gemini Chat ─────────────────────────
async function _callGemini(userMessage, history, maxRetries = 1) {
  const contents = [];

  history.slice(-6).forEach(h => {
    contents.push({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    });
  });

  contents.push({
    role: "user",
    parts: [{ text: SYSTEM_PROMPT + "\n\n" + userMessage }],
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    for (const MODEL of MODELS) {
      console.log("Using Gemini model:", MODEL);
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents }),
          }
        );

        if (res.ok) {
          const data = await res.json();
          console.log("Gemini response:", data);
          return data.candidates?.[0]?.content?.parts?.[0]?.text || "(no response)";
        } else {
          const body = await res.text();
          console.warn(`Gemini model ${MODEL} failed on attempt ${attempt}:`, body.slice(0, 200));
        }
      } catch (e) {
        console.warn(`Gemini network error on ${MODEL}:`, e.message);
      }
    }
  }

  throw new Error("All Gemini models failed after retries.");
}

module.exports = router;