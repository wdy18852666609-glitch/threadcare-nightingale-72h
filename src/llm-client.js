const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "plan", "title", "riskReason", "category", "baseScore", "concepts", "suggestedTask", "sourceQuote"],
  properties: {
    summary: { type: "string" },
    plan: { type: "string" },
    title: { type: "string" },
    riskReason: { type: "string" },
    category: {
      type: "string",
      enum: [
        "patient_reported_concern",
        "patient_reported_symptom",
        "unverified_patient_hypothesis",
        "unverified_self_medication",
        "urgent_patient_report"
      ]
    },
    baseScore: { type: "integer", minimum: 0, maximum: 100 },
    concepts: {
      type: "object",
      additionalProperties: false,
      required: ["symptoms", "hypotheses", "actions", "duration", "urgent", "recurrent"],
      properties: {
        symptoms: { type: "array", items: { type: "string" } },
        hypotheses: { type: "array", items: { type: "string" } },
        actions: { type: "array", items: { type: "string" } },
        duration: { type: "string" },
        urgent: { type: "boolean" },
        recurrent: { type: "boolean" }
      }
    },
    suggestedTask: {
      type: "object",
      additionalProperties: false,
      required: ["resultType", "title", "rationale"],
      properties: {
        resultType: {
          type: "string",
          enum: ["glucose_panel", "respiratory_assessment", "neurological_assessment", "urgent_assessment", "general_assessment"]
        },
        title: { type: "string" },
        rationale: { type: "string" }
      }
    },
    sourceQuote: { type: "string" }
  }
};

const INSTRUCTIONS = `You are an AI clinical scribe for a synthetic-data care-note demo.
Extract only what the patient explicitly reports. Never diagnose, confirm a patient hypothesis, or invent a symptom, medication, or result.
Return concise English UI text even when the patient writes in another language.
Extract symptoms, hypotheses, actions/self-treatment, and any explicitly reported duration into separate structured fields. Use an empty string when duration is not reported.
The title must begin with the core symptom or concern, then add duration when reported (for example: "Cough · three months"). Never use a duration by itself as the title. The summary must distinguish symptoms, the patient's own hypothesis, and self-treatment.
baseScore ranks review urgency, not truth: 85-100 only for potential red flags, 55-75 for self-treatment or meaningful risk, 35-54 otherwise.
Choose an operational suggested task that matches the report. A suggested task is not a diagnosis.
sourceQuote must be one exact, contiguous, verbatim substring copied from the supplied de-identified message and should be the smallest passage supporting the highlight.
All output is a suggestion requiring clinician review.`;

const CONVERSATION_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "plan"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    plan: { type: "string" }
  }
};

function responseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function geminiResponseText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part?.text).filter(Boolean).join("");
  return text || null;
}

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  const converted = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["additionalProperties", "minimum", "maximum"].includes(key)) continue;
    converted[key] = key === "type" && typeof value === "string"
      ? value.toUpperCase()
      : toGeminiSchema(value);
  }
  return converted;
}

function sourceFromQuote(originalMessage, redactedMessage, sourceQuote) {
  const original = String(originalMessage);
  const redacted = String(redactedMessage);
  const quote = String(sourceQuote || "").trim();
  let startChar = original.indexOf(quote);
  if (startChar >= 0) return { text: quote, startChar, endChar: startChar + quote.length };

  // A PHI placeholder can make redacted indices differ from the original. In
  // that case preserve provenance by linking the complete original submission.
  if (quote && redacted.includes(quote)) {
    return { text: original, startChar: 0, endChar: original.length };
  }
  return { text: original, startChar: 0, endChar: original.length };
}

function reportedDuration(message) {
  const match = String(message).match(/\bfor\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hour|day|week|month|year)s?)\b/i);
  return match?.[1] || "";
}

function structuredTitle(analysis, originalMessage) {
  const symptoms = (analysis.concepts?.symptoms || []).map((item) => String(item).trim()).filter(Boolean);
  if (!symptoms.length) return String(analysis.title || "Patient-reported concern").trim();
  const symptomText = symptoms.join(" and ");
  const duration = String(analysis.concepts?.duration || reportedDuration(originalMessage)).trim().replace(/^for\s+/i, "");
  const hypotheses = (analysis.concepts?.hypotheses || []).map((item) => String(item).trim()).filter(Boolean);
  const base = `${symptomText.charAt(0).toUpperCase()}${symptomText.slice(1)}${duration ? ` · ${duration}` : ""}`;
  return hypotheses.length ? `${base}; patient suspects ${hypotheses.join(" or ")}` : base;
}

async function callOpenAi({ instructions, input, format = null }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error("External LLM is not configured. Set OPENAI_API_KEY on the server and restart the demo.");
    error.status = 503;
    throw error;
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        store: false,
        instructions,
        input,
        ...(format ? { text: { format: { type: "json_schema", name: format.name, strict: true, schema: format.schema } } } : {})
      }),
      signal: controller.signal
    });
  } catch (cause) {
    const error = new Error(cause?.name === "AbortError" ? "External LLM request timed out." : "External LLM request failed.");
    error.status = 502;
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`External LLM returned ${response.status}: ${details.slice(0, 240)}`);
    error.status = 502;
    throw error;
  }
  const payload = await response.json();
  const output = responseText(payload);
  if (!output) {
    const error = new Error("External LLM returned no output.");
    error.status = 502;
    throw error;
  }
  return { output, model: payload.model || model, provider: "openai" };
}

async function callGoogle({ instructions, input, format = null }) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    const error = new Error("Google Gemini is not configured. Set GOOGLE_API_KEY on the server and restart the demo.");
    error.status = 503;
    throw error;
  }

  const baseUrl = (process.env.GOOGLE_API_BASE_URL || "https://aiplatform.googleapis.com/v1").replace(/\/$/, "");
  const model = process.env.GOOGLE_MODEL || "gemini-2.5-flash";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  let response;
  try {
    response = await fetch(`${baseUrl}/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: "user", parts: [{ text: input }] }],
        generationConfig: {
          temperature: 0.2,
          ...(format ? {
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(format.schema)
          } : {})
        }
      }),
      signal: controller.signal
    });
  } catch (cause) {
    const error = new Error(cause?.name === "AbortError" ? "External LLM request timed out." : "External LLM request failed.");
    error.status = 502;
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Google Gemini returned ${response.status}: ${details.slice(0, 1200)}`);
    error.status = 502;
    throw error;
  }
  const payload = await response.json();
  const output = geminiResponseText(payload);
  if (!output) {
    const error = new Error("Google Gemini returned no output.");
    error.status = 502;
    throw error;
  }
  return { output, model: payload.modelVersion || model, provider: "google-vertex-ai" };
}

async function callExternalLlm(options) {
  const configuredProvider = (process.env.LLM_PROVIDER || "").toLowerCase();
  if (process.env.OPENAI_BASE_URL) return callOpenAi(options);
  if (configuredProvider === "google" || (!configuredProvider && process.env.GOOGLE_API_KEY)) {
    return callGoogle(options);
  }
  return callOpenAi(options);
}

export async function analyzePatientMessage(redactedMessage, originalMessage = redactedMessage) {
  const { output, model, provider } = await callExternalLlm({
    instructions: INSTRUCTIONS,
    input: `De-identified patient message:\n${redactedMessage}`,
    format: { name: "patient_message_analysis", schema: ANALYSIS_SCHEMA }
  });
  let analysis;
  try {
    analysis = JSON.parse(output);
  } catch {
    const error = new Error("External LLM returned invalid structured analysis.");
    error.status = 502;
    throw error;
  }
  return {
    ...analysis,
    title: structuredTitle(analysis, originalMessage),
    provider,
    model,
    source: sourceFromQuote(originalMessage, redactedMessage, analysis.sourceQuote)
  };
}

export async function generateIntakeReply(messages) {
  const transcript = messages.map((message) => `${message.authorRole}: ${message.redactedBody ?? message.body}`).join("\n");
  const { output, model, provider } = await callExternalLlm({
    instructions: `You are a pre-consult intake assistant, not a doctor. Ask one short, useful follow-up question at a time. Never diagnose or recommend starting, stopping, or changing medication. If the message describes an emergency warning sign, advise urgent in-person help. Clearly say a clinician will review the conversation.`,
    input: `De-identified conversation:\n${transcript}`
  });
  return { body: output.trim(), provider, model };
}

export async function summarizeConversation(kind, messages) {
  const transcript = messages.map((message) => `[${message.id}] ${message.authorRole}: ${message.redactedBody ?? message.body}`).join("\n");
  const { output, model, provider } = await callExternalLlm({
    instructions: `Summarize this ${kind.replaceAll("_", " ")} conversation for a longitudinal clinical timeline. Distinguish patient reports, clinician statements, staff operations, unresolved questions, and tasks. Do not convert an unverified statement into a fact. Keep the title under 12 words, the summary under 55 words, and the plan under 30 words.`,
    input: transcript,
    format: { name: "conversation_timeline_summary", schema: CONVERSATION_SUMMARY_SCHEMA }
  });
  try {
    return { ...JSON.parse(output), provider, model };
  } catch {
    const error = new Error("External LLM returned invalid conversation summary.");
    error.status = 502;
    throw error;
  }
}
