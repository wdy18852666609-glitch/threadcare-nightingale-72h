import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  actorFromRequest,
  assertClinicScope,
  canReadEntry,
  requirePermission
} from "./src/auth.js";
import {
  addComment,
  closeConsultation,
  conversationView,
  createEntry,
  createPatientSession,
  createTask,
  editEntrySection,
  getState,
  pinHighlight,
  publicPatientView,
  rejectAndReplaceHighlight,
  resetState,
  resolveComment,
  revertEntry,
  sendConversationMessage,
  summarizeConversationToTimeline,
  updateTask
} from "./src/store.js";
import { redactPhi } from "./src/redaction.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, "public");

async function loadLocalEnvironment() {
  try {
    const contents = await readFile(path.join(root, ".env.local"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1].startsWith("#") || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function persistLocalEnvironment(updates) {
  const environmentPath = path.join(root, ".env.local");
  let contents = "";
  try {
    contents = await readFile(environmentPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const remaining = new Map(Object.entries(updates));
  const lines = contents.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  while (lines.length && !lines.at(-1)) lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  await writeFile(environmentPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

await loadLocalEnvironment();
const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArgument?.split("=")[1] || 3000);
const demoMode = process.argv.includes("--demo");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

function findPatient(patientId) {
  return getState().patients.find((item) => item.id === patientId);
}

function assertPatientAccess(actor, patientId) {
  const patient = findPatient(patientId);
  if (!patient) {
    const error = new Error("Patient not found");
    error.status = 404;
    throw error;
  }
  assertClinicScope(actor, patient.clinicId);
  return patient;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    const googleConfigured = Boolean(process.env.GOOGLE_API_KEY);
    return sendJson(response, 200, {
      status: "ok",
      externalLlmConfigured: googleConfigured || Boolean(process.env.OPENAI_API_KEY),
      provider: googleConfigured ? "google-vertex-ai" : "openai",
      model: googleConfigured
        ? process.env.GOOGLE_MODEL || "gemini-2.5-flash"
        : process.env.OPENAI_MODEL || "gpt-5.4-mini"
    });
  }

  if (request.method === "POST" && url.pathname === "/api/demo/configure-llm") {
    if (!demoMode || request.headers["x-local-setup"] !== "threadcare-demo") {
      return sendJson(response, 404, { error: "Not found" });
    }
    const body = await readJson(request);
    const apiKey = String(body.apiKey || "").trim();
    if (!apiKey) return sendJson(response, 400, { error: "API key is required" });
    process.env.GOOGLE_API_KEY = apiKey;
    process.env.LLM_PROVIDER = "google";
    process.env.GOOGLE_MODEL = String(body.model || "gemini-2.5-flash");
    if (body.persist === true) {
      await persistLocalEnvironment({
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
        GOOGLE_MODEL: process.env.GOOGLE_MODEL,
        LLM_PROVIDER: "google"
      });
    }
    return sendJson(response, 200, {
      configured: true,
      persisted: body.persist === true,
      provider: "google-vertex-ai",
      model: process.env.GOOGLE_MODEL
    });
  }

  if (request.method === "POST" && url.pathname === "/api/test/reset") {
    if (!demoMode) return sendJson(response, 404, { error: "Not found" });
    return sendJson(response, 200, resetState());
  }

  const actor = actorFromRequest(request);

  if (request.method === "GET" && url.pathname === "/api/patients") {
    requirePermission(actor, "read:clinical_team");
    return sendJson(response, 200, getState().patients.filter((item) => item.clinicId === actor.clinicId));
  }

  if (request.method === "POST" && url.pathname === "/api/patient-sessions") {
    requirePermission(actor, "create:patient_session");
    const body = await readJson(request);
    assertPatientAccess(actor, body.patientId);
    if (!String(body.message || "").trim()) return sendJson(response, 400, { error: "Message is required" });
    const redacted = redactPhi(body.message, body.knownNames || []);
    return sendJson(response, 201, await createPatientSession(body, redacted, actor));
  }

  if (request.method === "GET" && url.pathname === "/api/conversations") {
    requirePermission(actor, "read:conversation");
    const patientId = url.searchParams.get("patientId") || "P-1001";
    assertPatientAccess(actor, patientId);
    return sendJson(response, 200, conversationView(patientId, actor));
  }

  const conversationMessageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (request.method === "POST" && conversationMessageMatch) {
    requirePermission(actor, "write:conversation");
    const conversation = getState().conversations.find((item) => item.id === conversationMessageMatch[1]);
    if (!conversation) return sendJson(response, 404, { error: "Conversation not found" });
    assertClinicScope(actor, conversation.clinicId);
    const roleCannotWrite =
      !conversation.participants.includes(actor.role) ||
      (conversation.kind === "patient_ai" && actor.role !== "patient") ||
      (conversation.kind === "nurse_patient" && !["patient", "staff"].includes(actor.role));
    if (roleCannotWrite) {
      return sendJson(response, 403, { error: "Role cannot write to this conversation" });
    }
    const body = await readJson(request);
    if (!String(body.body || "").trim()) return sendJson(response, 400, { error: "Message is required" });
    const redactedBody = redactPhi(body.body, body.knownNames || []);
    return sendJson(response, 201, await sendConversationMessage(conversation.id, body.body, redactedBody, actor));
  }

  const conversationSummaryMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/summarize$/);
  if (request.method === "POST" && conversationSummaryMatch) {
    requirePermission(actor, "summarize:conversation");
    const conversation = getState().conversations.find((item) => item.id === conversationSummaryMatch[1]);
    if (!conversation) return sendJson(response, 404, { error: "Conversation not found" });
    assertClinicScope(actor, conversation.clinicId);
    if (!conversation.participants.includes(actor.role)) return sendJson(response, 403, { error: "Conversation is not visible to this role" });
    return sendJson(response, 200, await summarizeConversationToTimeline(conversation.id, actor));
  }

  if (request.method === "POST" && url.pathname === "/api/consultations/close") {
    requirePermission(actor, "close:consultation");
    const body = await readJson(request);
    assertPatientAccess(actor, body.patientId);
    if (!String(body.assessment || "").trim() || !String(body.advice || "").trim()) {
      return sendJson(response, 400, { error: "Assessment and patient advice are required" });
    }
    return sendJson(response, 201, closeConsultation(body, actor));
  }

  const patientMatch = url.pathname.match(/^\/api\/patients\/([^/]+)$/);
  if (request.method === "GET" && patientMatch) {
    const patientId = patientMatch[1];
    assertPatientAccess(actor, patientId);
    if (actor.role === "admin") {
      return sendJson(response, 403, { error: "Admin uses metadata-only audit view" });
    }
    return sendJson(response, 200, publicPatientView(patientId, actor, canReadEntry));
  }

  const sourceMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/source$/);
  if (request.method === "GET" && sourceMatch) {
    const entry = getState().entries.find((item) => item.id === sourceMatch[1]);
    if (!entry) return sendJson(response, 404, { error: "Entry not found" });
    assertClinicScope(actor, entry.clinicId);
    if (!canReadEntry(actor, entry)) return sendJson(response, 403, { error: "Source is not visible to this role" });
    return sendJson(response, 200, {
      entryId: entry.id,
      interactionType: entry.type,
      authorRole: entry.authorRole,
      occurredAt: entry.occurredAt,
      generatedAt: entry.generatedAt,
      spans: entry.spans
    });
  }

  const replaceMatch = url.pathname.match(/^\/api\/highlights\/([^/]+)\/reject-and-replace$/);
  if (request.method === "POST" && replaceMatch) {
    requirePermission(actor, "decide:highlight");
    const item = getState().highlights.find((highlight) => highlight.id === replaceMatch[1]);
    if (!item) return sendJson(response, 404, { error: "Highlight not found" });
    assertClinicScope(actor, item.clinicId);
    const body = await readJson(request);
    if (!body.diagnosis || !body.patientSummary) return sendJson(response, 400, { error: "Replacement clinical and patient-facing conclusions are required" });
    return sendJson(response, 200, rejectAndReplaceHighlight(item.id, body, actor));
  }

  const pinMatch = url.pathname.match(/^\/api\/highlights\/([^/]+)\/pin$/);
  if (request.method === "POST" && pinMatch) {
    requirePermission(actor, "decide:highlight");
    const item = getState().highlights.find((highlight) => highlight.id === pinMatch[1]);
    if (!item) return sendJson(response, 404, { error: "Highlight not found" });
    assertClinicScope(actor, item.clinicId);
    return sendJson(response, 200, pinHighlight(item.id, actor));
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    requirePermission(actor, "create:task");
    const body = await readJson(request);
    assertPatientAccess(actor, body.patientId);
    if (!String(body.title || "").trim() || !String(body.rationale || "").trim()) {
      return sendJson(response, 400, { error: "Task content and instructions are required" });
    }
    return sendJson(response, 201, createTask(body, actor));
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    requirePermission(actor, "read:clinical_team");
    return sendJson(response, 200, getState().tasks.filter((item) => item.clinicId === actor.clinicId));
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (request.method === "PATCH" && taskMatch) {
    requirePermission(actor, "update:task");
    const task = getState().tasks.find((item) => item.id === taskMatch[1]);
    if (!task) return sendJson(response, 404, { error: "Task not found" });
    assertClinicScope(actor, task.clinicId);
    const body = await readJson(request);
    return sendJson(response, 200, updateTask(task.id, body.status, actor, body.results, body.scheduledAt));
  }

  const commentMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/comments$/);
  if (request.method === "POST" && commentMatch) {
    requirePermission(actor, "write:comment");
    const entry = getState().entries.find((item) => item.id === commentMatch[1]);
    if (!entry) return sendJson(response, 404, { error: "Entry not found" });
    assertClinicScope(actor, entry.clinicId);
    const body = await readJson(request);
    return sendJson(response, 201, addComment(entry.id, body.body, actor));
  }

  const resolveMatch = url.pathname.match(/^\/api\/comments\/([^/]+)$/);
  if (request.method === "PATCH" && resolveMatch) {
    requirePermission(actor, "write:comment");
    const comment = getState().comments.find((item) => item.id === resolveMatch[1]);
    if (!comment) return sendJson(response, 404, { error: "Comment not found" });
    assertClinicScope(actor, comment.clinicId);
    const body = await readJson(request);
    return sendJson(response, 200, resolveComment(comment.id, body.resolved, actor));
  }

  if (request.method === "POST" && url.pathname === "/api/entries") {
    const body = await readJson(request);
    const permission = actor.role === "clinician" ? "write:clinician_note" : "write:staff_note";
    requirePermission(actor, permission);
    assertPatientAccess(actor, body.patientId);
    if (actor.role === "staff" && body.supersedesEntryId) {
      return sendJson(response, 403, { error: "Staff cannot supersede a clinical or AI source" });
    }
    if (!String(body.summary || "").trim()) {
      return sendJson(response, 400, { error: "Note summary is required" });
    }
    return sendJson(response, 201, createEntry(body, actor));
  }

  const editMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/sections\/([^/]+)$/);
  if (request.method === "PATCH" && editMatch) {
    const [entryId, section] = editMatch.slice(1);
    const entry = getState().entries.find((item) => item.id === entryId);
    if (!entry) return sendJson(response, 404, { error: "Entry not found" });
    assertClinicScope(actor, entry.clinicId);
    const permission = actor.role === "clinician" ? "write:clinician_note" : "write:staff_note";
    requirePermission(actor, permission);
    const body = await readJson(request);
    return sendJson(response, 200, editEntrySection(entryId, section, body.content, body.baseVersion, actor));
  }

  const revertMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/revert$/);
  if (request.method === "POST" && revertMatch) {
    const permission = actor.role === "clinician" ? "revert:clinician_note" : "revert:staff_note";
    requirePermission(actor, permission);
    const entry = getState().entries.find((item) => item.id === revertMatch[1]);
    if (!entry) return sendJson(response, 404, { error: "Entry not found" });
    assertClinicScope(actor, entry.clinicId);
    const body = await readJson(request);
    return sendJson(response, 200, revertEntry(entry.id, body.targetVersion, actor));
  }

  if (request.method === "GET" && url.pathname === "/api/versions") {
    requirePermission(actor, actor.role === "clinician" ? "read:clinical_team" : "read:clinical_team");
    return sendJson(response, 200, getState().versions.filter((item) => {
      const entry = getState().entries.find((candidate) => candidate.id === item.entryId);
      return entry?.clinicId === actor.clinicId;
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/audit") {
    requirePermission(actor, "read:audit");
    return sendJson(response, 200, getState().audit.filter((item) => item.clinicId === actor.clinicId));
  }

  if (request.method === "POST" && url.pathname === "/api/redact") {
    if (!["staff", "clinician"].includes(actor.role)) return sendJson(response, 403, { error: "Forbidden" });
    const body = await readJson(request);
    return sendJson(response, 200, { redacted: redactPhi(body.text, body.knownNames || []) });
  }

  return sendJson(response, 404, { error: "Not found" });
}

async function serveStatic(request, response, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicRoot, requested));
  if (!filePath.startsWith(publicRoot)) return sendJson(response, 403, { error: "Forbidden" });
  try {
    const contents = await readFile(filePath);
    response.writeHead(200, { "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
    response.end(contents);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(request, response, url);
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`Nightingale Care Note running at http://localhost:${port}`);
});
