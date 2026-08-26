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
  const timeout = setTimeout(() => controller.abort(), 10_000);
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
  const timeout = setTimeout(() => controller.abort(), 10_000);
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

async function callConfiguredProvider(options) {
  const configuredProvider = (process.env.LLM_PROVIDER || "").toLowerCase();
  if (process.env.OPENAI_BASE_URL) return callOpenAi(options);
  if (configuredProvider === "google" || (!configuredProvider && process.env.GOOGLE_API_KEY)) {
    return callGoogle(options);
  }
  return callOpenAi(options);
}

let llmCircuitOpenUntil = 0;

function isTransientLlmError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.status === 502 || error?.status === 503 ||
    /timeout|timed out|resource exhausted|rate limit|429|500|502|503|504|temporar/.test(message);
}

async function callExternalLlm(options) {
  if (Date.now() < llmCircuitOpenUntil) {
    const error = new Error("External LLM is temporarily unavailable");
    error.status = 503;
    throw error;
  }
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await callConfiguredProvider(options);
    } catch (error) {
      lastError = error;
      if (!isTransientLlmError(error) || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
    }
  }
  llmCircuitOpenUntil = Date.now() + 60_000;
  throw lastError;
}

function localPatientAnalysis(message) {
  const original = String(message).trim();
  const lower = original.toLowerCase();
  const symptomPatterns = [
    ["dry cough", /\bdry cough\b/], ["cough", /\bcough(?:ing)?\b/],
    ["wheezing", /\bwheez(?:e|ing)\b/], ["dizziness", /\bdizz(?:y|iness)\b/],
    ["burning urination", /\bburning\b.*\b(?:urinate|urination|urine)\b|\bdysuria\b/],
    ["urinary frequency", /\b(?:urinate|urination|urine)\b.*\b(?:often|frequent|frequency|more often)\b/],
    ["headache", /\bheadache\b/], ["fever", /\bfever\b/],
    ["chest pain", /\bchest pain\b/], ["shortness of breath", /\bshortness of breath\b|\bdifficulty breathing\b/]
  ];
  const symptoms = symptomPatterns.filter(([, pattern]) => pattern.test(lower)).map(([label]) => label);
  const hypotheses = [
    ["low blood sugar", /\blow blood sugar\b|\bhypoglyc/],
    ["a lingering cold", /\b(?:just |lingering )?cold\b/],
    ["dehydration", /\bdehydrat/], ["migraine", /\bmigraine\b/]
  ].filter(([, pattern]) => pattern.test(lower)).map(([label]) => label);
  const actions = [
    ["glucose", /\bglucose\b/], ["over-the-counter medicine", /\bover[- ]the[- ]counter\b/],
    ["antibiotics", /\bantibiotic/]
  ].filter(([, pattern]) => pattern.test(lower)).map(([label]) => label);
  const duration = reportedDuration(original);
  const urgent = /\bsevere difficulty breathing\b|\bcan(?:not|'t) breathe\b|\bchest pain\b|\bcough(?:ing)? up blood\b/.test(lower) &&
    !/\bno (?:fever|chest pain|severe difficulty breathing)\b/.test(lower);
  const symptomText = symptoms.length ? symptoms.join(" and ") : "new concern";
  const summaryParts = [`Patient reports ${symptomText}${duration ? ` for ${duration}` : ""}.`];
  if (hypotheses.length) summaryParts.push(`Patient suspects ${hypotheses.join(" or ")}; this is unverified.`);
  if (actions.length) summaryParts.push(`Patient reports ${actions.join(" and ")}.`);
  const titleBase = symptoms.length ? symptoms.slice(0, 2).join(" and ") : "Patient-reported concern";
  const title = `${titleBase.charAt(0).toUpperCase()}${titleBase.slice(1)}${duration ? ` · ${duration}` : ""}`;
  return {
    summary: summaryParts.join(" "),
    plan: urgent ? "Prompt clinician triage is required." : "Clinician review is required; AI has not made a diagnosis.",
    title,
    riskReason: urgent ? "possible urgent symptom reported" : hypotheses.length ? "unverified patient hypothesis requires clinician review" : "new patient-reported symptom",
    category: urgent ? "urgent_patient_report" : hypotheses.length ? "unverified_patient_hypothesis" : "patient_reported_symptom",
    baseScore: urgent ? 90 : hypotheses.length ? 58 : 42,
    concepts: { symptoms, hypotheses, actions, duration, urgent, recurrent: /\b(?:again|recurrent|sometimes|often)\b/.test(lower) },
    suggestedTask: { resultType: "general_assessment", title: "Clinician-selected assessment", rationale: "The clinician should choose any appropriate next step." },
    sourceQuote: original,
    provider: "local-safe-fallback",
    model: "deterministic-fallback",
    source: { text: original, startChar: 0, endChar: original.length }
  };
}

function localIntakeReply(messages) {
  const latest = [...messages].reverse().find((message) => message.authorRole === "patient");
  const lower = String(latest?.redactedBody ?? latest?.body ?? "").toLowerCase();
  let body = "Could you tell me when this started and whether it is getting worse? A clinician will review this conversation.";
  if (/\bcough|wheez/.test(lower)) body = "Do you have shortness of breath at rest, chest pain, fever, or cough up blood? A clinician will review this conversation.";
  if (/\burinat|urine|dysuria|burning/.test(lower)) body = "Do you have fever, back or side pain, vomiting, trouble passing urine, or pelvic pain? A clinician will review this conversation.";
  if (/\bdizz|blood sugar|glucose/.test(lower)) body = "When does the dizziness happen, how long does it last, and have you taken anything for it? A clinician will review this conversation.";
  return { body, provider: "local-safe-fallback", model: "deterministic-fallback" };
}

function localConversationSummary(kind, messages) {
  const patientMessages = messages.filter((message) => message.authorRole === "patient").map((message) => message.redactedBody ?? message.body);
  const teamMessages = messages.filter((message) => message.authorRole !== "patient" && message.authorRole !== "system").map((message) => message.redactedBody ?? message.body);
  const latestPatient = patientMessages.at(-1) || "No patient reply recorded.";
  const latestTeam = teamMessages.at(-1) || "Care-team review remains pending.";
  return {
    title: kind === "patient_ai" ? "Patient pre-consult update" : "Care conversation update",
    summary: `Patient report: ${latestPatient}`.slice(0, 360),
    plan: String(latestTeam).slice(0, 220),
    provider: "local-safe-fallback",
    model: "deterministic-fallback"
  };
}

export async function analyzePatientMessage(redactedMessage, originalMessage = redactedMessage) {
  let response;
  try {
    response = await callExternalLlm({
      instructions: INSTRUCTIONS,
      input: `De-identified patient message:\n${redactedMessage}`,
      format: { name: "patient_message_analysis", schema: ANALYSIS_SCHEMA }
    });
  } catch {
    return localPatientAnalysis(originalMessage);
  }
  const { output, model, provider } = response;
  let analysis;
  try {
    analysis = JSON.parse(output);
  } catch {
    return localPatientAnalysis(originalMessage);
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
  let response;
  try {
    response = await callExternalLlm({
      instructions: `You are a pre-consult intake assistant, not a doctor. Ask one short, useful follow-up question at a time. Never diagnose or recommend starting, stopping, or changing medication. If the message describes an emergency warning sign, advise urgent in-person help. Clearly say a clinician will review the conversation.`,
      input: `De-identified conversation:\n${transcript}`
    });
  } catch {
    return localIntakeReply(messages);
  }
  const { output, model, provider } = response;
  return { body: output.trim(), provider, model };
}

export async function summarizeConversation(kind, messages) {
  const transcript = messages.map((message) => `[${message.id}] ${message.authorRole}: ${message.redactedBody ?? message.body}`).join("\n");
  let response;
  try {
    response = await callExternalLlm({
      instructions: `Summarize this ${kind.replaceAll("_", " ")} conversation for a longitudinal clinical timeline. Distinguish patient reports, clinician statements, staff operations, unresolved questions, and tasks. Do not convert an unverified statement into a fact. Keep the title under 12 words, the summary under 55 words, and the plan under 30 words.`,
      input: transcript,
      format: { name: "conversation_timeline_summary", schema: CONVERSATION_SUMMARY_SCHEMA }
    });
  } catch {
    return localConversationSummary(kind, messages);
  }
  const { output, model, provider } = response;
  try {
    return { ...JSON.parse(output), provider, model };
  } catch {
    return localConversationSummary(kind, messages);
  }
}

export async function transcribeAudio(audioBase64, mimeType = "audio/wav") {
  if (process.env.TEST_AUTH_BYPASS === "true" && process.env.OPENAI_BASE_URL) {
    const response = await callOpenAi({
      instructions: "Return a plain speech transcript only.",
      input: "Synthetic audio transcription test."
    });
    return { transcript: response.output.trim(), provider: response.provider, model: response.model };
  }
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    const error = new Error("Voice transcription requires GOOGLE_API_KEY on the server.");
    error.status = 503;
    throw error;
  }
  const supportedMimeTypes = new Set(["audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac"]);
  if (!supportedMimeTypes.has(mimeType)) {
    const error = new Error("Unsupported audio format. Please record again in this browser.");
    error.status = 400;
    throw error;
  }
  const baseUrl = (process.env.GOOGLE_API_BASE_URL || "https://aiplatform.googleapis.com/v1").replace(/\/$/, "");
  const model = process.env.GOOGLE_MODEL || "gemini-2.5-flash";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch(`${baseUrl}/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are a speech-to-text engine. Return only the verbatim spoken transcript. Preserve the spoken language. Do not summarize, diagnose, answer questions, guess, or add commentary. If there is no clearly intelligible speech, return exactly [NO_SPEECH]." }] },
        contents: [{ role: "user", parts: [
          { text: "Transcribe the speech in this audio." },
          { inlineData: { mimeType: mimeType === "audio/x-wav" ? "audio/wav" : mimeType, data: audioBase64 } }
        ] }],
        generationConfig: { temperature: 0 }
      }),
      signal: controller.signal
    });
  } catch (cause) {
    const error = new Error(cause?.name === "AbortError" ? "Voice transcription timed out. Please try a shorter recording." : "Voice transcription request failed.");
    error.status = 502;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Voice transcription returned ${response.status}: ${details.slice(0, 300)}`);
    error.status = 502;
    throw error;
  }
  const payload = await response.json();
  const transcript = geminiResponseText(payload)?.trim();
  if (!transcript || /^\[?NO_SPEECH\]?$/i.test(transcript) || /^\(?no (?:clear )?speech(?: detected)?\)?[.!]?$/i.test(transcript)) {
    const error = new Error("No clear speech was detected.");
    error.status = 422;
    throw error;
  }
  return { transcript, provider: "google-vertex-ai", model: payload.modelVersion || model };
}
