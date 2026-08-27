import http from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  actorFromRequest,
  actorForAccount,
  assertClinicScope,
  canReadEntry,
  requirePermission
} from "./src/auth.js";
import {
  addAudit,
  addComment,
  addConsultationFeedback,
  closeConsultation,
  conversationView,
  createEntry,
  createPatientSession,
  createTask,
  deduplicateTaskResultEntries,
  editEntrySection,
  getState,
  pinHighlight,
  publicPatientView,
  purgePatientsExcept,
  replaceState,
  rejectAndReplaceHighlight,
  resetState,
  registerPatient,
  resolveComment,
  revertEntry,
  sendConversationMessage,
  startConsultation,
  summarizeConversationToTimeline,
  updateTask
} from "./src/store.js";
import { redactPhi } from "./src/redaction.js";
import { transcribeAudio } from "./src/llm-client.js";

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
const persistMode = process.argv.includes("--persist");
const allowTestHeaders = process.env.TEST_AUTH_BYPASS === "true";
const sessions = new Map();
const SESSION_COOKIE = "threadcare_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const statePath = path.join(root, "data", "demo-state.json");
let persistQueue = Promise.resolve();

async function loadPersistedState() {
  if (!persistMode) return;
  try {
    replaceState(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function persistState() {
  if (!persistMode) return Promise.resolve();
  persistQueue = persistQueue.then(async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(getState(), null, 2), "utf8");
    await rename(temporaryPath, statePath);
  });
  return persistQueue;
}

await loadPersistedState();

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 32);
}

function passwordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

const teamAccounts = new Map([
  ["clinician:dr.lee", { username: "dr.lee", role: "clinician", actorId: "clinician-lee", displayName: "Dr Lee", clinicId: "clinic-sg-01", password: passwordRecord(process.env.CLINICIAN_PASSWORD || "clinician123") }],
  ["staff:maya", { username: "maya", role: "staff", actorId: "staff-maya", displayName: "Nurse Maya", clinicId: "clinic-sg-01", password: passwordRecord(process.env.STAFF_PASSWORD || "staff123") }],
  ["staff:noah", { username: "noah", role: "staff", actorId: "staff-noah", displayName: "Nurse Noah", clinicId: "clinic-sg-01", password: passwordRecord(process.env.STAFF_NOAH_PASSWORD || "staff456") }],
  ["admin:clinic.ops", { username: "clinic.ops", role: "admin", actorId: "admin-ops", displayName: "Clinic Ops", clinicId: "clinic-sg-01", password: passwordRecord(process.env.ADMIN_PASSWORD || "admin123") }]
]);
const defaultUsernames = { clinician: "dr.lee", staff: "maya", admin: "clinic.ops" };

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((item) => item.trim().split("=")).filter((item) => item.length === 2));
}

function createSession(response, account) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { ...account, expiresAt: Date.now() + SESSION_TTL_MS });
  response.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
  return token;
}

function clearSession(request, response) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  response.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function sessionAccount(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function publicAccount(account) {
  return account ? { username: account.username || null, role: account.role, actorId: account.actorId, displayName: account.displayName, clinicId: account.clinicId, patientId: account.patientId || null } : null;
}

function actorForRequest(request) {
  const account = sessionAccount(request);
  if (account) return actorForAccount(account);
  if (allowTestHeaders && request.headers["x-role"]) return actorFromRequest(request);
  const error = new Error("Please sign in to continue");
  error.status = 401;
  throw error;
}

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
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > 12 * 1024 * 1024) {
      const error = new Error("Request is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
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
  if (actor.role === "patient" && actor.patientId && actor.patientId !== patientId) {
    const error = new Error("Patients can only access their own record");
    error.status = 403;
    throw error;
  }
  return patient;
}

function assertPatientResourceAccess(actor, patientId) {
  if (actor.role === "patient" && actor.patientId && actor.patientId !== patientId) {
    const error = new Error("Patients can only access their own record");
    error.status = 403;
    throw error;
  }
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

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    return sendJson(response, 200, { account: publicAccount(sessionAccount(request)) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    const role = String(body.role || "").toLowerCase();
    const username = String(body.username || defaultUsernames[role] || "").trim().toLowerCase();
    const account = teamAccounts.get(`${role}:${username}`);
    const provided = hashPassword(String(body.password || ""), account?.password.salt || "invalid-login-salt");
    if (!account || provided.length !== account.password.hash.length || !timingSafeEqual(provided, account.password.hash)) {
      return sendJson(response, 401, { error: "Incorrect role password" });
    }
    createSession(response, account);
    return sendJson(response, 200, { account: publicAccount(account) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register-patient") {
    const body = await readJson(request);
    const requestedPatientId = String(body.patientId || "").trim().toUpperCase();
    const age = Number(body.age);
    if (!Number.isInteger(age) || age < 1 || age > 120) {
      return sendJson(response, 400, { error: "A valid synthetic age is required" });
    }
    let patient = requestedPatientId ? getState().patients.find((item) => item.id === requestedPatientId) : null;
    if (requestedPatientId) {
      if (!patient) return sendJson(response, 404, { error: "Patient ID was not found" });
      if (patient.age !== age) return sendJson(response, 403, { error: "Patient ID and age do not match" });
    } else {
      if (body.syntheticConfirmed !== true) return sendJson(response, 400, { error: "This prototype accepts synthetic demo information only" });
      if (!String(body.givenName || "").trim() || !String(body.familyName || "").trim()) {
        return sendJson(response, 400, { error: "Synthetic first name and family name are required for a new patient" });
      }
      const displayName = `${String(body.title || "").trim() ? `${String(body.title).trim()} ` : ""}${String(body.givenName).trim()} ${String(body.familyName).trim()} (synthetic)`;
      const registrationActor = actorForAccount({ role: "patient", actorId: `patient-registration-${Date.now()}`, clinicId: "clinic-sg-01", displayName });
      patient = registerPatient({ ...body, age }, registrationActor).patient;
    }
    const account = { username: patient.id.toLowerCase(), role: "patient", actorId: `patient-${patient.id.toLowerCase()}`, displayName: patient.displayName, clinicId: patient.clinicId, patientId: patient.id };
    createSession(response, account);
    return sendJson(response, 201, { account: publicAccount(account), patient });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSession(request, response);
    return sendJson(response, 200, { signedOut: true });
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
    if (!allowTestHeaders && sessionAccount(request)?.role !== "admin") return sendJson(response, 403, { error: "Admin access required" });
    return sendJson(response, 200, resetState());
  }

  const actor = actorForRequest(request);

  if (request.method === "POST" && url.pathname === "/api/transcriptions") {
    requirePermission(actor, "transcribe:audio");
    const body = await readJson(request);
    const audioBase64 = String(body.audioBase64 || "");
    const mimeType = String(body.mimeType || "audio/wav").toLowerCase();
    if (!audioBase64 || audioBase64.length > 10_500_000 || !/^[A-Za-z0-9+/=]+$/.test(audioBase64)) {
      return sendJson(response, 400, { error: "A valid recording under 8 MB is required" });
    }
    if (body.patientId) assertPatientAccess(actor, body.patientId);
    const result = await transcribeAudio(audioBase64, mimeType);
    addAudit(actor, "audio.transcribed", "transcription", `TR-${Date.now()}`, {
      patientId: body.patientId || null,
      byteLength: Math.floor(audioBase64.length * 0.75),
      provider: result.provider,
      model: result.model,
      audioRetained: false
    });
    return sendJson(response, 200, result);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/demo-patients/purge") {
    if (!demoMode) return sendJson(response, 404, { error: "Not found" });
    requirePermission(actor, "read:audit");
    return sendJson(response, 200, purgePatientsExcept("P-1001", actor));
  }

  if (request.method === "POST" && url.pathname === "/api/admin/demo-task-results/deduplicate") {
    if (!demoMode) return sendJson(response, 404, { error: "Not found" });
    requirePermission(actor, "read:audit");
    const body = await readJson(request);
    return sendJson(response, 200, deduplicateTaskResultEntries(String(body.taskId || ""), actor));
  }

  if (request.method === "POST" && url.pathname === "/api/admin/reset-demo") {
    if (!demoMode) return sendJson(response, 404, { error: "Not found" });
    requirePermission(actor, "read:audit");
    const reset = resetState();
    return sendJson(response, 200, {
      reset: true,
      patientCount: reset.patients.length,
      entryCount: reset.entries.length,
      profile: "final-demo-start"
    });
  }

  if (request.method === "GET" && url.pathname === "/api/patients") {
    requirePermission(actor, "read:clinical_team");
    const clinicState = getState();
    return sendJson(response, 200, clinicState.patients.filter((item) => item.clinicId === actor.clinicId).map((patient) => ({
      ...patient,
      needsReviewCount: clinicState.highlights.filter((item) => item.patientId === patient.id && item.status === "suggested").length,
      openTaskCount: clinicState.tasks.filter((item) => item.patientId === patient.id && !["reviewed", "cancelled"].includes(item.status)).length,
      consultationStatus: clinicState.consultations.filter((item) => item.patientId === patient.id).at(-1)?.status || "none"
    })));
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
    const patientId = url.searchParams.get("patientId");
    if (!patientId) return sendJson(response, 400, { error: "Patient is required" });
    assertPatientAccess(actor, patientId);
    return sendJson(response, 200, conversationView(patientId, actor));
  }

  const conversationMessageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (request.method === "POST" && conversationMessageMatch) {
    requirePermission(actor, "write:conversation");
    const conversation = getState().conversations.find((item) => item.id === conversationMessageMatch[1]);
    if (!conversation) return sendJson(response, 404, { error: "Conversation not found" });
    assertClinicScope(actor, conversation.clinicId);
    assertPatientResourceAccess(actor, conversation.patientId);
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
    assertPatientResourceAccess(actor, conversation.patientId);
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

  if (request.method === "POST" && url.pathname === "/api/consultations/start") {
    requirePermission(actor, "start:consultation");
    const body = await readJson(request);
    assertPatientAccess(actor, body.patientId);
    return sendJson(response, 201, startConsultation(body.patientId, actor, body.trigger || "manual"));
  }

  if (request.method === "POST" && url.pathname === "/api/consultations/feedback") {
    requirePermission(actor, "submit:consultation_feedback");
    const body = await readJson(request);
    assertPatientAccess(actor, body.patientId);
    return sendJson(response, 201, addConsultationFeedback(body, actor));
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
    assertPatientResourceAccess(actor, entry.patientId);
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
    if (!String(body.reason || "").trim() || !String(body.diagnosis || "").trim()) {
      return sendJson(response, 400, { error: "Reason and replacement clinical assessment are required" });
    }
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
    const patientId = url.searchParams.get("patientId");
    return sendJson(response, 200, getState().tasks.filter((item) => item.clinicId === actor.clinicId && (!patientId || item.patientId === patientId)));
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

let apiRequestQueue = Promise.resolve();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const result = apiRequestQueue.then(async () => {
        await handleApi(request, response, url);
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && response.statusCode < 400) await persistState();
      });
      apiRequestQueue = result.then(() => undefined, () => undefined);
      await result;
    }
    else await serveStatic(request, response, url);
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`Nightingale Care Note running at http://localhost:${port}`);
});
