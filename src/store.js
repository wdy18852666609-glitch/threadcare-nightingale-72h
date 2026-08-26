import { analyzePatientMessage, generateIntakeReply, summarizeConversation } from "./llm-client.js";

const nowIso = () => new Date().toISOString();
const MS_PER_DAY = 86_400_000;
const dayKey = (value) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date(value));

function normaliseLearningToken(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function learningKeysFor(highlight) {
  const entry = state.entries.find((item) => item.id === highlight.entryId);
  const concepts = entry?.extractedConcepts || {};
  const keys = [
    `category:${normaliseLearningToken(highlight.category)}`,
    ...(concepts.symptoms || []).map((item) => `symptom:${normaliseLearningToken(item)}`),
    ...(concepts.hypotheses || []).map((item) => `hypothesis:${normaliseLearningToken(item)}`),
    ...(concepts.actions || []).map((item) => `action:${normaliseLearningToken(item)}`),
    ...(concepts.urgent ? ["risk:urgent"] : []),
    ...(concepts.recurrent ? ["pattern:recurrent"] : []),
    ...(/month|year/i.test(concepts.duration || "") ? ["pattern:persistent"] : [])
  ];
  return [...new Set(keys.filter((key) => !key.endsWith(":")))];
}

function importanceModel(clinicId) {
  state.importanceModels ||= {};
  state.importanceModels[clinicId] ||= { weights: {}, interactions: [] };
  return state.importanceModels[clinicId];
}

function recordImportanceFeedback(highlight, actor, delta, interaction) {
  const model = importanceModel(highlight.clinicId);
  const keys = learningKeysFor(highlight);
  for (const key of keys) {
    model.weights[key] = Math.max(-30, Math.min(30, (model.weights[key] || 0) + delta));
  }
  model.interactions.unshift({
    id: `IL-${model.interactions.length + 1}`,
    highlightId: highlight.id,
    actorRole: actor.role,
    actorId: actor.actorId,
    interaction,
    delta,
    keys,
    at: nowIso()
  });
  return { keys, learnedWeight: learnedWeightFor(highlight) };
}

function learnedWeightFor(highlight) {
  const model = importanceModel(highlight.clinicId);
  const weights = learningKeysFor(highlight).map((key) => model.weights[key] || 0);
  return weights.length ? Math.max(-30, Math.min(30, Math.max(...weights))) : 0;
}

function importanceExplanation(highlight) {
  const entry = state.entries.find((item) => item.id === highlight.entryId);
  const concepts = entry?.extractedConcepts || {};
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(entry?.occurredAt || nowIso()).getTime()) / MS_PER_DAY));
  const linkedTask = state.tasks.find((item) => item.sourceHighlightId === highlight.id && !["reviewed", "cancelled"].includes(item.status));
  const learningKeys = learningKeysFor(highlight);
  const model = importanceModel(highlight.clinicId);
  const matchedSignals = learningKeys
    .filter((key) => model.weights[key])
    .map((key) => ({ key, label: key.replace(":", ": ").replaceAll("_", " "), weight: model.weights[key] }));
  const breakdown = {
    base: highlight.baseScore,
    explicitRisk: concepts.urgent ? 8 : 0,
    recency: ageDays <= 7 ? 4 : ageDays <= 30 ? 2 : 0,
    unresolvedAction: linkedTask ? 5 : 0,
    teamLearning: learnedWeightFor(highlight)
  };
  return {
    score: Math.max(0, Math.min(99, Object.values(breakdown).reduce((total, value) => total + value, 0))),
    breakdown,
    matchedSignals,
    learningKeys,
    ageDays,
    policy: "Team feedback changes ranking only; it never turns an AI suggestion into a clinical fact."
  };
}

function storagePolicyFor(entry) {
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(entry.occurredAt).getTime()) / MS_PER_DAY));
  const protectedTypes = new Set(["allergy_verification", "confirmed_diagnosis"]);
  const unresolvedTask = state.tasks.some((task) =>
    task.patientId === entry.patientId &&
    (task.resultEntryId === entry.id || task.sourceHighlightId && state.highlights.find((highlight) => highlight.id === task.sourceHighlightId)?.entryId === entry.id) &&
    !["reviewed", "cancelled"].includes(task.status)
  );
  const unresolvedComment = state.comments.some((comment) => comment.entryId === entry.id && !comment.resolved);
  const protectedReason = protectedTypes.has(entry.type)
    ? "Persistent safety or confirmed clinical fact"
    : entry.status === "needs_review"
      ? "Awaiting clinical review"
      : unresolvedTask
        ? "Linked to an unresolved action"
        : unresolvedComment
          ? "Has an unresolved collaboration thread"
          : null;
  if (protectedReason) return { tier: "hot", ageDays, reason: protectedReason, defaultCollapsed: false, rawSourceRetained: true };

  const isAiOrSystem = entry.authorRole === "system" || entry.type.startsWith("ai_") || entry.type === "system_event";
  const coldAfterDays = isAiOrSystem ? 180 : 730;
  const warmAfterDays = isAiOrSystem ? 30 : 180;
  const tier = ageDays >= coldAfterDays ? "cold" : ageDays >= warmAfterDays ? "warm" : "hot";
  return {
    tier,
    ageDays,
    reason: tier === "cold"
      ? "Older, resolved low-priority context is collapsed; exact evidence remains available"
      : tier === "warm"
        ? "Older context remains visible but is no longer prioritised by recency"
        : "Recent active context",
    defaultCollapsed: tier === "cold",
    rawSourceRetained: true
  };
}

function archiveBuckets(entries) {
  const coldEntries = entries.filter((entry) => entry.storage?.tier === "cold");
  const byYear = new Map();
  for (const entry of coldEntries) {
    const year = new Date(entry.occurredAt).getFullYear();
    const bucket = byYear.get(year) || { year, count: 0, entryIds: [], types: {}, rawSourcesRetained: true };
    bucket.count += 1;
    bucket.entryIds.push(entry.id);
    bucket.types[entry.type] = (bucket.types[entry.type] || 0) + 1;
    byYear.set(year, bucket);
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

function patientSessionSummary(reports) {
  const uniqueReports = [...new Set((reports || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!uniqueReports.length) return "Patient pre-consult awaiting summary.";
  const [initialConcern, ...followUps] = uniqueReports;
  return `Initial concern: ${initialConcern}${followUps.length ? ` Follow-up details: ${followUps.join(" ")}` : ""}`;
}

function consultationConversations(patientId, clinicId, consultationId) {
  const suffix = patientId === "P-1001" && consultationId === "CONS-1" ? "" : `-${patientId}-${consultationId}`;
  return [
    { id: `C-PATIENT-AI${suffix}`, patientId, clinicId, consultationId, kind: "patient_ai", participants: ["patient", "system", "clinician"], messages: [], summaryEntryId: null, dailySummaryEntryIds: {} },
    { id: `C-PATIENT-CLINICIAN${suffix}`, patientId, clinicId, consultationId, kind: "patient_clinician", participants: ["patient", "clinician"], messages: [], summaryEntryId: null },
    { id: `C-PATIENT-STAFF${suffix}`, patientId, clinicId, consultationId, kind: "nurse_patient", participants: ["patient", "staff", "clinician"], messages: [], summaryEntryId: null },
    { id: `C-CLINICAL-TEAM${suffix}`, patientId, clinicId, consultationId, kind: "clinical_team", participants: ["clinician", "staff"], messages: [], summaryEntryId: null }
  ];
}

function latestConsultation(patientId) {
  return state.consultations.filter((item) => item.patientId === patientId).at(-1) || null;
}

function openConsultation(patientId) {
  return state.consultations.findLast((item) => item.patientId === patientId && item.status === "open") || null;
}

function initialState() {
  const consultation = {
    id: "CONS-1",
    sequence: 1,
    patientId: "P-1001",
    status: "open",
    startedAt: nowIso(),
    startedBy: "system-demo",
    activityStarted: false,
    closedAt: null,
    closedBy: null,
    outcomeEntryId: null,
    feedback: null
  };
  return {
    patients: [
      {
        id: "P-1001",
        clinicId: "clinic-sg-01",
        displayName: "Mr Chen (synthetic)",
        age: 68,
        pronouns: "he/him",
        lastVisit: "2025-04-15",
        safetyBanner: "Synthetic demonstration data only",
        allergies: [
          {
            substance: "Penicillin",
            reaction: "Severe allergic reaction",
            severity: "critical",
            status: "clinician_confirmed",
            sourceEntryId: "E-ALLERGY-01"
          }
        ]
      },
      {
        id: "P-1002",
        clinicId: "clinic-sg-01",
        displayName: "Ms Taylor (synthetic)",
        age: 41,
        pronouns: "she/her",
        lastVisit: "No previous visit",
        registeredAt: "2026-08-26T08:00:00+08:00",
        safetyBanner: "Synthetic demonstration data only",
        allergies: []
      }
    ],
    entries: [
      {
        id: "E-ARCHIVE-01",
        patientId: "P-1001",
        consultationId: null,
        clinicId: "clinic-sg-01",
        authorRole: "system",
        authorId: "ai-scribe",
        authorName: "AI Scribe",
        type: "ai_patient_session_summary",
        occurredAt: "2024-01-12T09:00:00+08:00",
        generatedAt: "2024-01-12T09:01:00+08:00",
        visibility: "clinical_team",
        status: "resolved",
        sections: {
          summary: "Patient previously reported a brief seasonal cough that resolved without an open follow-up.",
          plan: "No unresolved action; retain the exact synthetic source for longitudinal context."
        },
        spans: [
          {
            id: "S-ARCHIVE-01",
            text: "I had a mild cough during the rainy week, but it has now gone away.",
            messageBody: "I had a mild cough during the rainy week, but it has now gone away.",
            authorRole: "patient",
            authorName: "Mr Chen",
            occurredAt: "2024-01-12T08:58:00+08:00"
          }
        ],
        extractedConcepts: {
          symptoms: ["cough"],
          hypotheses: [],
          actions: [],
          duration: "brief",
          urgent: false,
          recurrent: false
        },
        aiProvider: "seeded-synthetic-demo",
        aiModel: "not-generated-at-runtime",
        version: 1,
        supersededBy: null
      },
      {
        id: "E-ALLERGY-01",
        patientId: "P-1001",
        clinicId: "clinic-sg-01",
        authorRole: "clinician",
        authorId: "clinician-lim",
        authorName: "Dr Lee",
        type: "allergy_verification",
        occurredAt: "2024-11-02T14:30:00+08:00",
        generatedAt: null,
        visibility: "clinical_team",
        status: "clinician_confirmed",
        sections: {
          summary: "Severe penicillin allergy confirmed and added to the persistent safety record.",
          plan: "Keep visible in every clinical glance view regardless of age."
        },
        spans: [],
        version: 1,
        supersededBy: null
      },
      {
        id: "E-PREVIOUS-01",
        patientId: "P-1001",
        consultationId: null,
        clinicId: "clinic-sg-01",
        authorRole: "clinician",
        authorId: "clinician-lee",
        authorName: "Dr Lee",
        type: "consultation_outcome",
        occurredAt: "2025-04-15T16:20:00+08:00",
        generatedAt: null,
        visibility: "patient",
        status: "clinician_confirmed",
        sections: {
          summary: "Previous synthetic consultation completed with no continuing acute concern.",
          plan: "Return if symptoms recur or a new concern develops."
        },
        spans: [],
        version: 1,
        supersededBy: null
      }
    ],
    highlights: [],
    tasks: [],
    comments: [],
    versions: [],
    feedbackWeights: { unverified_self_medication: 0 },
    importanceModels: { "clinic-sg-01": { weights: {}, interactions: [] } },
    conversations: consultationConversations("P-1001", "clinic-sg-01", consultation.id),
    prescriptions: [],
    consultations: [consultation],
    audit: []
  };
}

let state = initialState();

export function resetState() {
  state = initialState();
  return snapshot();
}

export function snapshot() {
  return structuredClone(state);
}

export function getState() {
  return state;
}

export function replaceState(savedState) {
  if (!savedState || !Array.isArray(savedState.patients) || !Array.isArray(savedState.consultations)) {
    throw new Error("Saved care state is invalid");
  }
  state = structuredClone(savedState);
  state.importanceModels ||= {};
  for (const clinicId of new Set(state.patients.map((patient) => patient.clinicId))) {
    importanceModel(clinicId);
  }
  return snapshot();
}

export function purgePatientsExcept(patientId, actor) {
  const removedPatientIds = new Set(state.patients.filter((patient) => patient.id !== patientId).map((patient) => patient.id));
  const removedResourceIds = new Set();
  for (const collection of ["entries", "highlights", "tasks", "comments", "conversations", "prescriptions", "consultations"]) {
    for (const item of state[collection].filter((candidate) => removedPatientIds.has(candidate.patientId))) {
      removedResourceIds.add(item.id);
    }
    state[collection] = state[collection].filter((candidate) => !removedPatientIds.has(candidate.patientId));
  }
  state.versions = state.versions.filter((version) => !removedResourceIds.has(version.entryId));
  state.audit = state.audit.filter((event) =>
    !removedResourceIds.has(event.resourceId) &&
    !removedPatientIds.has(event.resourceId) &&
    !removedPatientIds.has(event.metadata?.patientId)
  );
  state.patients = state.patients.filter((patient) => patient.id === patientId);
  addAudit(actor, "demo_patients.purged", "patient", patientId, { removedCount: removedPatientIds.size });
  return { keptPatientId: patientId, removedPatientIds: [...removedPatientIds] };
}

export function deduplicateTaskResultEntries(taskId, actor) {
  const task = state.tasks.find((item) => item.id === taskId);
  const keptEntry = state.entries.find((entry) => entry.id === task?.resultEntryId);
  if (!task || !keptEntry) {
    const error = new Error("Task result was not found");
    error.status = 404;
    throw error;
  }
  const keptTime = new Date(keptEntry.occurredAt).getTime();
  const duplicateIds = new Set(state.entries.filter((entry) =>
    entry.id !== keptEntry.id &&
    entry.patientId === task.patientId &&
    entry.consultationId === task.consultationId &&
    entry.type === keptEntry.type &&
    Math.abs(new Date(entry.occurredAt).getTime() - keptTime) <= 60_000
  ).map((entry) => entry.id));
  state.entries = state.entries.filter((entry) => !duplicateIds.has(entry.id));
  state.comments = state.comments.filter((comment) => !duplicateIds.has(comment.entryId));
  state.versions = state.versions.filter((version) => !duplicateIds.has(version.entryId));
  state.audit = state.audit.filter((event) => !duplicateIds.has(event.resourceId));
  addAudit(actor, "task_results.deduplicated", "task", taskId, { keptEntryId: keptEntry.id, removedEntryIds: [...duplicateIds] });
  return { taskId, keptEntryId: keptEntry.id, removedEntryIds: [...duplicateIds] };
}

export function registerPatient(input, actor) {
  const number = Math.max(1000, ...state.patients.map((item) => Number(item.id.replace(/\D/g, "")) || 0)) + 1;
  const patientId = `P-${number}`;
  const title = String(input.title || "").trim();
  const givenName = String(input.givenName || "").trim();
  const familyName = String(input.familyName || "").trim();
  const displayName = `${title ? `${title} ` : ""}${[givenName, familyName].filter(Boolean).join(" ")} (synthetic)`;
  const patient = {
    id: patientId,
    clinicId: actor.clinicId,
    displayName,
    age: Number(input.age),
    pronouns: String(input.pronouns || "not specified"),
    phone: String(input.phone || ""),
    lastVisit: "No previous visit",
    registeredAt: nowIso(),
    safetyBanner: "Synthetic demonstration data only",
    allergies: []
  };
  state.patients.push(patient);
  const consultation = startConsultation(patientId, actor, "patient_registration");
  addAudit(actor, "patient.registered", "patient", patientId, { synthetic: true });
  return { patient, consultation };
}

export function addAudit(actor, action, resourceType, resourceId, metadata = {}) {
  const event = {
    id: `A-${state.audit.length + 1}`,
    actorRole: actor.role,
    actorId: actor.actorId,
    clinicId: actor.clinicId,
    action,
    resourceType,
    resourceId,
    at: nowIso(),
    metadata
  };
  state.audit.unshift(event);
  return event;
}

export function startConsultation(patientId, actor, trigger = "manual") {
  const existing = openConsultation(patientId);
  if (existing) {
    if (existing.activityStarted === false) {
      existing.activityStarted = true;
      existing.startedAt = nowIso();
      existing.startedBy = actor.actorId;
      existing.startTrigger = trigger;
      addAudit(actor, "consultation.activated", "consultation", existing.id, { patientId, trigger });
    }
    return existing;
  }
  const sequence = state.consultations.filter((item) => item.patientId === patientId).length + 1;
  const consultation = {
    id: `CONS-${patientId}-${sequence}`,
    sequence,
    patientId,
    status: "open",
    startedAt: nowIso(),
    startedBy: actor.actorId,
    startTrigger: trigger,
    activityStarted: true,
    closedAt: null,
    closedBy: null,
    outcomeEntryId: null,
    feedback: null
  };
  state.consultations.push(consultation);
  const patient = state.patients.find((item) => item.id === patientId);
  state.conversations.push(...consultationConversations(patientId, patient?.clinicId || actor.clinicId, consultation.id));
  addAudit(actor, "consultation.started", "consultation", consultation.id, { patientId, sequence, trigger });
  return consultation;
}

export function publicPatientView(patientId, actor, canReadEntry) {
  const patient = state.patients.find((item) => item.id === patientId);
  if (!patient) return null;

  const entries = state.entries
    .filter((entry) => entry.patientId === patientId && canReadEntry(actor, entry))
    .map((entry) => ({ ...entry, storage: storagePolicyFor(entry) }))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const consultation = latestConsultation(patientId);
  if (actor.role === "patient") {
    return {
      patient,
      entries,
      highlights: [],
      tasks: state.tasks
        .filter((item) => item.patientId === patientId && item.scheduledAt && !["cancelled", "reviewed"].includes(item.status))
        .map(({ id, title, status, scheduledAt, consultationId }) => ({ id, title, status, scheduledAt, consultationId })),
      comments: [],
      prescriptions: state.prescriptions.filter((item) => item.patientId === patientId),
      consultation,
      consultations: state.consultations.filter((item) => item.patientId === patientId),
      archiveBuckets: archiveBuckets(entries),
      storagePolicy: { mode: "non-destructive-tiering", rawSourcesRetained: true }
    };
  }

  const highlights = state.highlights
    .filter((item) => item.patientId === patientId && item.status !== "rejected")
    .map((item) => ({ ...item, learnedWeight: learnedWeightFor(item), ...importanceExplanation(item) }))
    .sort((a, b) => b.score - a.score);

  return {
    patient,
    entries,
    highlights,
    tasks: state.tasks.filter((item) => item.patientId === patientId),
    comments: state.comments.filter((item) => item.patientId === patientId),
    prescriptions: state.prescriptions.filter((item) => item.patientId === patientId),
    consultation,
    consultations: state.consultations.filter((item) => item.patientId === patientId),
    archiveBuckets: archiveBuckets(entries),
    storagePolicy: { mode: "non-destructive-tiering", rawSourcesRetained: true }
  };
}

export async function createPatientSession(input, redactedMessage, actor) {
  const current = latestConsultation(input.patientId);
  const consultation = !current || current.status === "closed"
    ? startConsultation(input.patientId, actor, "patient_pre_consult")
    : current;
  if (consultation.activityStarted === false) {
    consultation.activityStarted = true;
    consultation.startedAt = nowIso();
    consultation.startedBy = actor.actorId;
    consultation.startTrigger = "patient_pre_consult";
  }
  const occurredAt = nowIso();
  const analysis = await analyzePatientMessage(redactedMessage, input.message);
  const intakeConversation = state.conversations.find((item) => item.kind === "patient_ai" && item.patientId === input.patientId && item.consultationId === consultation.id);
  const patientMessage = addMessageRecord(intakeConversation, input.message, redactedMessage, actor, {
    sourceStartChar: analysis.source.startChar,
    sourceEndChar: analysis.source.endChar,
    sourceText: analysis.source.text
  });
  const aiReply = await generateIntakeReply(intakeConversation.messages);
  const aiMessage = addMessageRecord(
    intakeConversation,
    aiReply.body,
    aiReply.body,
    { role: "system", actorId: "intake-assistant", displayName: "AI Intake", clinicId: actor.clinicId },
    { aiProvider: aiReply.provider, aiModel: aiReply.model }
  );
  const patientEntry = {
    id: `E-${state.entries.length + 1}`,
    patientId: input.patientId,
    consultationId: consultation.id,
    clinicId: actor.clinicId,
    authorRole: "patient",
    authorId: actor.actorId,
    authorName: actor.displayName || "Patient",
    type: "patient_message",
    occurredAt,
    generatedAt: null,
    visibility: "patient",
    status: "submitted",
    sections: {
      summary: input.message,
      plan: "Shared with the clinical team for review."
    },
    spans: [],
    version: 1,
    supersededBy: null
  };
  state.entries.push(patientEntry);

  const day = dayKey(occurredAt);
  const dailyMessages = intakeConversation.messages.filter((message) => dayKey(message.createdAt) === day);
  const dailySummary = await summarizeConversation("patient_ai", dailyMessages);
  const dailySpans = dailyMessages.map((message) => ({
    id: `S-${message.id}`,
    messageId: message.id,
    text: message.sourceText || message.body,
    messageBody: message.body,
    authorRole: message.authorRole,
    authorName: message.authorName,
    ...(message.sourceStartChar !== undefined ? { startChar: message.sourceStartChar, endChar: message.sourceEndChar } : {}),
    occurredAt: message.createdAt
  }));
  intakeConversation.dailySummaryEntryIds ||= {};
  let aiEntry = state.entries.find((item) => item.id === intakeConversation.dailySummaryEntryIds[day]);
  if (aiEntry?.status === "superseded") aiEntry = null;
  if (aiEntry) {
    const previousConcepts = aiEntry.extractedConcepts || {};
    const mergeList = (left = [], right = []) => [...new Set([...left, ...right])];
    aiEntry.title = dailySummary.title;
    aiEntry.patientReportSummaries = [...new Set([...(aiEntry.patientReportSummaries || []), analysis.summary])];
    aiEntry.sections = { summary: patientSessionSummary(aiEntry.patientReportSummaries), plan: dailySummary.plan };
    aiEntry.spans = dailySpans;
    aiEntry.generatedAt = nowIso();
    aiEntry.extractedConcepts = {
      ...previousConcepts,
      ...analysis.concepts,
      symptoms: mergeList(previousConcepts.symptoms, analysis.concepts?.symptoms),
      hypotheses: mergeList(previousConcepts.hypotheses, analysis.concepts?.hypotheses),
      actions: mergeList(previousConcepts.actions, analysis.concepts?.actions),
      duration: analysis.concepts?.duration || previousConcepts.duration || "",
      urgent: Boolean(previousConcepts.urgent || analysis.concepts?.urgent),
      recurrent: Boolean(previousConcepts.recurrent || analysis.concepts?.recurrent)
    };
    aiEntry.aiProvider = dailySummary.provider;
    aiEntry.aiModel = dailySummary.model;
    aiEntry.version += 1;
  } else {
    aiEntry = {
      id: `E-${state.entries.length + 1}`,
      patientId: input.patientId,
      consultationId: consultation.id,
      clinicId: actor.clinicId,
      authorRole: "system",
      authorId: "ai-scribe",
      authorName: "AI Scribe",
      type: "ai_patient_session_summary",
      occurredAt: dailyMessages[0].createdAt,
      generatedAt: nowIso(),
      visibility: "clinical_team",
      status: "needs_review",
      sections: { summary: patientSessionSummary([analysis.summary]), plan: analysis.plan },
      patientReportSummaries: [analysis.summary],
      title: analysis.title,
      spans: dailySpans,
      extractedConcepts: analysis.concepts,
      aiProvider: dailySummary.provider,
      aiModel: dailySummary.model,
      version: 1,
      supersededBy: null
    };
    state.entries.push(aiEntry);
    intakeConversation.dailySummaryEntryIds[day] = aiEntry.id;
  }

  let highlight = state.highlights.find((item) => item.entryId === aiEntry.id && item.status !== "rejected");
  const highlightFields = {
    spanId: `S-${patientMessage.id}`,
    category: analysis.category,
    title: analysis.title,
    riskReason: analysis.riskReason,
    baseScore: analysis.baseScore,
    suggestedTask: analysis.suggestedTask
  };
  if (highlight) {
    // A same-day follow-up often contains denials or qualifiers (for example,
    // "no shortness of breath"). Keep the original chief concern in the Top
    // Card instead of replacing it with the latest sentence fragment.
    Object.assign(highlight, {
      spanId: highlightFields.spanId,
      ...(highlightFields.baseScore > highlight.baseScore ? {
        category: highlightFields.category,
        riskReason: highlightFields.riskReason,
        baseScore: highlightFields.baseScore,
        suggestedTask: highlightFields.suggestedTask
      } : {})
    });
  } else {
    highlight = {
      id: `H-${state.highlights.length + 1}`,
      patientId: input.patientId,
      consultationId: consultation.id,
      clinicId: actor.clinicId,
      entryId: aiEntry.id,
      ...highlightFields,
      status: "suggested",
      decidedBy: null,
      decidedAt: null
    };
    state.highlights.push(highlight);
  }
  addAudit(actor, "patient_session.submitted", "entry", patientEntry.id, {
    aiEntryId: aiEntry.id,
    phiRedactedBeforeSummary: true,
    aiProvider: analysis.provider,
    aiModel: analysis.model
  });
  return {
    consultation,
    patientEntry,
    conversationMessages: [patientMessage, aiMessage],
    acknowledgement: "Your message was shared for clinician review. It has not been diagnosed by AI."
  };
}

function addMessageRecord(conversation, body, redactedBody, actor, metadata = {}) {
  const message = {
    id: `M-${state.conversations.reduce((total, item) => total + item.messages.length, 0) + 1}`,
    conversationId: conversation.id,
    patientId: conversation.patientId,
    clinicId: conversation.clinicId,
    authorRole: actor.role,
    authorId: actor.actorId,
    authorName: actor.displayName || actor.actorId,
    body: String(body).trim(),
    redactedBody: String(redactedBody).trim(),
    createdAt: nowIso(),
    ...metadata
  };
  conversation.messages.push(message);
  return message;
}

export function conversationView(patientId, actor) {
  const consultation = latestConsultation(patientId);
  if (!consultation) return [];
  return state.conversations
    .filter((conversation) => conversation.patientId === patientId && conversation.consultationId === consultation.id && conversation.participants.includes(actor.role))
    .map((conversation) => ({ ...conversation, messages: conversation.messages.map(({ redactedBody, ...message }) => message) }));
}

export async function sendConversationMessage(conversationId, body, redactedBody, actor) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return null;
  const consultation = state.consultations.find((item) => item.id === conversation.consultationId);
  if (consultation?.activityStarted === false) consultation.activityStarted = true;
  const message = addMessageRecord(conversation, body, redactedBody, actor);
  addAudit(actor, "conversation.message_sent", "conversation", conversation.id, { kind: conversation.kind });
  const created = [message];
  if (conversation.kind === "patient_ai" && actor.role === "patient") {
    const reply = await generateIntakeReply(conversation.messages);
    created.push(addMessageRecord(
      conversation,
      reply.body,
      reply.body,
      { role: "system", actorId: "intake-assistant", displayName: "AI Intake", clinicId: actor.clinicId },
      { aiProvider: reply.provider, aiModel: reply.model }
    ));
  }
  return created;
}

export async function summarizeConversationToTimeline(conversationId, actor) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return null;
  if (!conversation.messages.length) {
    const error = new Error("Conversation has no messages to summarize");
    error.status = 400;
    throw error;
  }
  const summary = await summarizeConversation(conversation.kind, conversation.messages);
  const spans = conversation.messages.map((message) => ({
    id: `S-${message.id}`,
    messageId: message.id,
    text: message.body,
    messageBody: message.body,
    authorRole: message.authorRole,
    authorName: message.authorName,
    occurredAt: message.createdAt
  }));
  const entryType = {
    patient_ai: "ai_patient_session_summary",
    patient_clinician: "ai_doctor_consult_summary",
    nurse_patient: "ai_nurse_consult_summary",
    clinical_team: "ai_clinical_team_summary"
  }[conversation.kind] || `ai_${conversation.kind}_summary`;
  let entry = state.entries.find((item) => item.id === conversation.summaryEntryId);
  if (entry) {
    entry.sections = { summary: summary.summary, plan: summary.plan };
    entry.spans = spans;
    entry.generatedAt = nowIso();
    entry.version += 1;
  } else {
    entry = {
      id: `E-${state.entries.length + 1}`,
      patientId: conversation.patientId,
      consultationId: conversation.consultationId,
      clinicId: conversation.clinicId,
      authorRole: "system",
      authorId: "ai-scribe",
      authorName: "AI Scribe",
      type: entryType,
      occurredAt: conversation.messages[0].createdAt,
      generatedAt: nowIso(),
      visibility: "clinical_team",
      status: "needs_review",
      sections: { summary: summary.summary, plan: summary.plan },
      title: summary.title,
      spans,
      version: 1,
      supersededBy: null,
      aiProvider: summary.provider,
      aiModel: summary.model
    };
    state.entries.push(entry);
    conversation.summaryEntryId = entry.id;
  }
  addAudit(actor, "conversation.summarized", "conversation", conversation.id, { entryId: entry.id, aiModel: summary.model });
  return entry;
}

export function closeConsultation(input, actor) {
  const consultation = openConsultation(input.patientId);
  if (!consultation) {
    const error = new Error("There is no open consultation to close");
    error.status = 409;
    throw error;
  }
  const outcomeEntry = createEntry(
    {
      patientId: input.patientId,
      consultationId: consultation.id,
      type: "consultation_outcome",
      visibility: "patient",
      status: "clinician_confirmed",
      summary: input.assessment,
      plan: input.advice
    },
    actor
  );
  const prescriptions = (input.medications || []).filter((item) => item.name).map((item) => ({
    id: `RX-${state.prescriptions.length + 1}`,
    patientId: input.patientId,
    consultationId: consultation.id,
    clinicId: actor.clinicId,
    name: item.name,
    dose: item.dose,
    frequency: item.frequency,
    instructions: item.instructions,
    prescribedBy: actor.actorId,
    prescribedAt: nowIso(),
    sourceEntryId: outcomeEntry.id,
    status: "active",
    synthetic: true
  }));
  state.prescriptions.push(...prescriptions);
  Object.assign(consultation, {
    status: "closed",
    closedAt: nowIso(),
    closedBy: actor.actorId,
    outcomeEntryId: outcomeEntry.id,
    feedback: null
  });
  addAudit(actor, "consultation.closed", "consultation", consultation.id, { outcomeEntryId: outcomeEntry.id, prescriptionCount: prescriptions.length });
  return { outcomeEntry, prescriptions, consultation };
}

export function rejectAndReplaceHighlight(highlightId, input, actor) {
  const highlight = state.highlights.find((item) => item.id === highlightId);
  if (!highlight) return null;
  highlight.status = "rejected";
  highlight.decidedBy = actor.actorId;
  highlight.decidedAt = nowIso();
  const learning = recordImportanceFeedback(highlight, actor, -10, "rejected");
  addAudit(actor, "highlight.rejected_with_replacement", "highlight", highlightId, {
    category: highlight.category,
    reason: input.reason,
    learningKeys: learning.keys,
    learnedWeight: learning.learnedWeight
  });

  const clinicalEntry = createEntry(
    {
      patientId: highlight.patientId,
      type: "confirmed_diagnosis",
      status: "clinician_confirmed",
      summary: input.diagnosis,
      plan: "Final advice and treatment will be documented when the consultation ends.",
      supersedesEntryId: highlight.entryId
    },
    actor
  );
  for (const task of state.tasks.filter((item) => item.sourceHighlightId === highlightId)) {
    if (task.status === "result_ready") {
      task.status = "reviewed";
      task.updatedBy = actor.actorId;
      task.updatedByName = actor.displayName || actor.actorId;
      task.updatedAt = nowIso();
    }
  }
  return {
    highlight: {
      ...highlight,
      learnedWeight: learning.learnedWeight,
      futureSimilarScore: highlight.baseScore + learning.learnedWeight
    },
    clinicalEntry
  };
}

export function addConsultationFeedback(input, actor) {
  const consultation = latestConsultation(input.patientId);
  if (!consultation || consultation.status !== "closed") {
    const error = new Error("Feedback is available after the consultation ends");
    error.status = 409;
    throw error;
  }
  if (consultation.feedback) {
    const error = new Error("Feedback has already been submitted");
    error.status = 409;
    throw error;
  }
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    const error = new Error("Rating must be between 1 and 5");
    error.status = 400;
    throw error;
  }
  consultation.feedback = {
    rating,
    comment: String(input.comment || "").trim(),
    submittedBy: actor.actorId,
    submittedAt: nowIso()
  };
  addAudit(actor, "consultation.feedback_submitted", "consultation", consultation.id, { rating });
  return consultation.feedback;
}

export function pinHighlight(highlightId, actor) {
  const highlight = state.highlights.find((item) => item.id === highlightId);
  if (!highlight) return null;
  if (highlight.status === "rejected") {
    const error = new Error("A rejected highlight cannot be pinned");
    error.status = 409;
    throw error;
  }
  const firstDecision = highlight.status !== "accepted";
  highlight.status = "accepted";
  highlight.decidedBy = actor.actorId;
  highlight.decidedAt = nowIso();
  let learning = { keys: learningKeysFor(highlight), learnedWeight: learnedWeightFor(highlight) };
  if (firstDecision) {
    learning = recordImportanceFeedback(highlight, actor, 10, "pinned");
  }
  addAudit(actor, "highlight.pinned_as_important", "highlight", highlightId, {
    category: highlight.category,
    learningKeys: learning.keys,
    learnedWeight: learning.learnedWeight,
    confirmsClinicalTruth: false
  });
  return {
    ...highlight,
    learnedWeight: learning.learnedWeight,
    futureSimilarScore: highlight.baseScore + learning.learnedWeight,
    ...importanceExplanation(highlight)
  };
}

export function createTask(input, actor) {
  const consultation = latestConsultation(input.patientId);
  if (consultation?.activityStarted === false) consultation.activityStarted = true;
  const task = {
    id: `T-${state.tasks.length + 1}`,
    patientId: input.patientId,
    consultationId: input.consultationId || consultation?.id || null,
    clinicId: actor.clinicId,
    title: input.title,
    rationale: input.rationale,
    resultType: input.resultType || "general_assessment",
    sourceHighlightId: input.sourceHighlightId,
    status: "to_do",
    createdBy: actor.actorId,
    createdByName: actor.displayName || actor.actorId,
    createdAt: nowIso(),
    updatedBy: actor.actorId,
    updatedByName: actor.displayName || actor.actorId,
    updatedAt: nowIso(),
    scheduledAt: null,
    results: null,
    resultEntryId: null
  };
  state.tasks.push(task);
  addAudit(actor, "task.created", "task", task.id, { status: task.status });
  return task;
}

export function updateTask(taskId, status, actor, results = null, scheduledAt = null) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return null;
  const allowed = ["to_do", "scheduled", "result_ready", "reviewed", "cancelled"];
  if (!allowed.includes(status)) {
    const error = new Error("Unknown task status");
    error.status = 400;
    throw error;
  }
  // Mobile browsers may submit the same completion several times while the
  // first response is still in flight. Once a result entry exists, completion
  // is idempotent and can never create another timeline event or reopen a
  // clinician-reviewed task.
  if (status === "result_ready" && task.resultEntryId) return task;
  if (status === "cancelled" && actor.role !== "clinician") {
    const error = new Error("Only a clinician can cancel a clinical task");
    error.status = 403;
    throw error;
  }
  if (status === "result_ready" && task.resultType === "glucose_panel" && (!results?.fastingGlucose || !results?.hba1c)) {
    const error = new Error("Synthetic fasting glucose and HbA1c results are required");
    error.status = 400;
    throw error;
  }
  if (status === "result_ready" && task.resultType !== "glucose_panel" && !String(results?.outcome || "").trim()) {
    const error = new Error("A synthetic assessment outcome is required");
    error.status = 400;
    throw error;
  }
  let normalizedScheduledAt = null;
  if (status === "scheduled") {
    const parsedSchedule = new Date(scheduledAt);
    if (!scheduledAt || Number.isNaN(parsedSchedule.getTime())) {
      const error = new Error("A valid test date and time is required");
      error.status = 400;
      throw error;
    }
    normalizedScheduledAt = parsedSchedule.toISOString();
  }
  const previousStatus = task.status;
  task.status = status;
  if (normalizedScheduledAt) task.scheduledAt = normalizedScheduledAt;
  if (status === "result_ready") {
    task.results = task.resultType === "glucose_panel"
      ? { fastingGlucose: results.fastingGlucose, hba1c: results.hba1c, unit: "mg/dL", synthetic: true }
      : { outcome: String(results.outcome).trim(), synthetic: true };
    const resultSummary = task.resultType === "glucose_panel"
      ? `Synthetic lab results: fasting glucose ${results.fastingGlucose} mg/dL; HbA1c ${results.hba1c}%.`
      : `Synthetic assessment outcome: ${task.results.outcome}`;
    const resultEntry = createEntry(
      {
        patientId: task.patientId,
        consultationId: task.consultationId,
        type: task.resultType === "glucose_panel" ? "lab_result" : "assessment_result",
        sourceTaskId: task.id,
        status: "result_ready",
        summary: resultSummary,
        plan: "Await clinician interpretation."
      },
      actor
    );
    task.resultEntryId = resultEntry.id;
  }
  task.updatedBy = actor.actorId;
  task.updatedByName = actor.displayName || actor.actorId;
  task.updatedAt = nowIso();
  addAudit(actor, "task.status_changed", "task", taskId, {
    from: previousStatus,
    to: status
  });
  return task;
}

export function addComment(entryId, body, actor) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return null;
  const firstTeamCommentOnEntry = ["clinician", "staff"].includes(actor.role) &&
    !state.comments.some((item) => item.entryId === entryId && item.authorId === actor.actorId);
  const comment = {
    id: `C-${state.comments.length + 1}`,
    patientId: entry.patientId,
    clinicId: entry.clinicId,
    entryId,
    authorRole: actor.role,
    authorId: actor.actorId,
    authorName: actor.displayName || actor.actorId,
    body,
    mentions: [...body.matchAll(/@(\w+)/g)].map((match) => match[1]),
    resolved: false,
    createdAt: nowIso()
  };
  state.comments.push(comment);
  const highlight = state.highlights.find((item) => item.entryId === entryId && item.status !== "rejected");
  const learning = highlight && firstTeamCommentOnEntry
    ? recordImportanceFeedback(highlight, actor, 2, "commented")
    : null;
  addAudit(actor, "comment.created", "comment", comment.id, {
    entryId,
    importanceLearning: learning ? { delta: 2, keys: learning.keys } : null
  });
  return comment;
}

export function resolveComment(commentId, resolved, actor) {
  const comment = state.comments.find((item) => item.id === commentId);
  if (!comment) return null;
  comment.resolved = Boolean(resolved);
  comment.resolvedBy = actor.actorId;
  comment.resolvedAt = nowIso();
  addAudit(actor, resolved ? "comment.resolved" : "comment.reopened", "comment", commentId);
  return comment;
}

export function createEntry(input, actor) {
  const consultation = latestConsultation(input.patientId);
  const entry = {
    id: `E-${state.entries.length + 1}`,
    patientId: input.patientId,
    consultationId: input.consultationId || consultation?.id || null,
    clinicId: actor.clinicId,
    authorRole: actor.role,
    authorId: actor.actorId,
    authorName: actor.displayName || actor.actorId,
    type: input.type || `${actor.role}_note`,
    sourceTaskId: input.sourceTaskId || null,
    occurredAt: input.occurredAt || nowIso(),
    generatedAt: null,
    visibility: input.visibility || "clinical_team",
    status: input.status || "active",
    sections: {
      summary: input.summary,
      plan: input.plan || ""
    },
    spans: [],
    version: 1,
    supersededBy: null
  };
  state.entries.push(entry);
  if (input.supersedesEntryId) {
    const prior = state.entries.find((item) => item.id === input.supersedesEntryId);
    if (prior) {
      prior.supersededBy = entry.id;
      prior.status = "superseded";
    }
  }
  addAudit(actor, "entry.created", "entry", entry.id, {
    type: entry.type,
    supersedesEntryId: input.supersedesEntryId || null
  });
  return entry;
}

export function editEntrySection(entryId, section, content, baseVersion, actor) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return null;
  if (entry.authorRole !== actor.role) {
    const error = new Error("Roles cannot overwrite notes authored by another role");
    error.status = 403;
    throw error;
  }
  if (!(section in entry.sections)) {
    const error = new Error("Unknown section");
    error.status = 400;
    throw error;
  }

  const latestSameSection = state.versions
    .filter((version) => version.entryId === entryId && version.section === section)
    .at(-1);
  if (baseVersion < entry.version && latestSameSection?.version > baseVersion) {
    const error = new Error("Edit conflict: this section changed after your base version");
    error.status = 409;
    throw error;
  }

  const previous = entry.sections[section];
  entry.version += 1;
  entry.sections[section] = content;
  const version = {
    id: `V-${state.versions.length + 1}`,
    entryId,
    section,
    previous,
    current: content,
    version: entry.version,
    changedBy: actor.actorId,
    changedAt: nowIso()
  };
  state.versions.push(version);
  addAudit(actor, "entry.section_edited", "entry", entryId, {
    section,
    version: entry.version
  });
  return { entry, version };
}

export function revertEntry(entryId, targetVersion, actor) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return null;
  if (entry.authorRole !== actor.role) {
    const error = new Error("Roles cannot revert notes authored by another role");
    error.status = 403;
    throw error;
  }
  const changes = state.versions
    .filter((item) => item.entryId === entryId && item.version > targetVersion)
    .sort((a, b) => b.version - a.version);
  if (!changes.length) {
    const error = new Error("No changes found after target version");
    error.status = 400;
    throw error;
  }
  for (const change of changes) {
    entry.sections[change.section] = change.previous;
  }
  entry.version += 1;
  addAudit(actor, "entry.reverted", "entry", entryId, { targetVersion, newVersion: entry.version });
  return entry;
}
