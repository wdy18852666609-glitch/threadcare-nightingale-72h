import { analyzePatientMessage, generateIntakeReply, summarizeConversation } from "./llm-client.js";

const nowIso = () => new Date().toISOString();
const dayKey = (value) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date(value));

function initialState() {
  return {
    patients: [
      {
        id: "P-1001",
        clinicId: "clinic-sg-01",
        displayName: "Mr Chen (synthetic)",
        age: 68,
        pronouns: "he/him",
        lastVisit: "2026-08-25",
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
      }
    ],
    entries: [
      {
        id: "E-ALLERGY-01",
        patientId: "P-1001",
        clinicId: "clinic-sg-01",
        authorRole: "clinician",
        authorId: "clinician-lim",
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
        id: "E-APR-01",
        patientId: "P-1001",
        clinicId: "clinic-sg-01",
        authorRole: "system",
        authorId: "ai-scribe",
        type: "ai_patient_session_summary",
        occurredAt: "2026-04-15T09:10:00+08:00",
        generatedAt: "2026-04-15T09:11:00+08:00",
        visibility: "clinical_team",
        status: "clinician_reviewed",
        sections: {
          summary: "Patient reported intermittent dizziness and self-treatment with glucose tablets based on an unconfirmed belief of low blood sugar.",
          plan: "Clinician follow-up recommended if symptoms recur."
        },
        spans: [
          {
            id: "S-APR-SELF-TREAT",
            startSeconds: 71,
            endSeconds: 83,
            text: "When I feel dizzy, I take glucose tablets because I think my sugar is low."
          }
        ],
        version: 1,
        supersededBy: null
      }
    ],
    highlights: [],
    tasks: [],
    comments: [],
    versions: [],
    feedbackWeights: {
      unverified_self_medication: 0
    },
    conversations: [
      { id: "C-PATIENT-AI", patientId: "P-1001", clinicId: "clinic-sg-01", kind: "patient_ai", participants: ["patient", "system", "clinician"], messages: [], summaryEntryId: null, dailySummaryEntryIds: {} },
      { id: "C-PATIENT-CLINICIAN", patientId: "P-1001", clinicId: "clinic-sg-01", kind: "patient_clinician", participants: ["patient", "clinician"], messages: [], summaryEntryId: null },
      { id: "C-PATIENT-STAFF", patientId: "P-1001", clinicId: "clinic-sg-01", kind: "nurse_patient", participants: ["patient", "staff", "clinician"], messages: [], summaryEntryId: null },
      { id: "C-CLINICAL-TEAM", patientId: "P-1001", clinicId: "clinic-sg-01", kind: "clinical_team", participants: ["clinician", "staff"], messages: [], summaryEntryId: null }
    ],
    prescriptions: [],
    consultation: { patientId: "P-1001", status: "open", closedAt: null, closedBy: null, outcomeEntryId: null },
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

export function publicPatientView(patientId, actor, canReadEntry) {
  const patient = state.patients.find((item) => item.id === patientId);
  if (!patient) return null;

  const entries = state.entries
    .filter((entry) => entry.patientId === patientId && canReadEntry(actor, entry))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  if (actor.role === "patient") {
    return {
      patient,
      entries,
      highlights: [],
      tasks: state.tasks
        .filter((item) => item.patientId === patientId && item.scheduledAt && item.status !== "cancelled")
        .map(({ id, title, status, scheduledAt }) => ({ id, title, status, scheduledAt })),
      comments: [],
      prescriptions: state.prescriptions.filter((item) => item.patientId === patientId),
      consultation: state.consultation
    };
  }

  const highlights = state.highlights
    .filter((item) => item.patientId === patientId && item.status !== "rejected")
    .map((item) => ({
      ...item,
      learnedWeight: state.feedbackWeights[item.category] || 0,
      score: item.baseScore + (state.feedbackWeights[item.category] || 0)
    }))
    .sort((a, b) => b.score - a.score);

  return {
    patient,
    entries,
    highlights,
    tasks: state.tasks.filter((item) => item.patientId === patientId),
    comments: state.comments.filter((item) => item.patientId === patientId),
    prescriptions: state.prescriptions.filter((item) => item.patientId === patientId),
    consultation: state.consultation
  };
}

export async function createPatientSession(input, redactedMessage, actor) {
  const occurredAt = nowIso();
  const analysis = await analyzePatientMessage(redactedMessage, input.message);
  const intakeConversation = state.conversations.find((item) => item.kind === "patient_ai" && item.patientId === input.patientId);
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
    { role: "system", actorId: "intake-assistant", clinicId: actor.clinicId },
    { aiProvider: aiReply.provider, aiModel: aiReply.model }
  );
  const patientEntry = {
    id: `E-${state.entries.length + 1}`,
    patientId: input.patientId,
    clinicId: actor.clinicId,
    authorRole: "patient",
    authorId: actor.actorId,
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
    ...(message.sourceStartChar !== undefined ? { startChar: message.sourceStartChar, endChar: message.sourceEndChar } : {}),
    occurredAt: message.createdAt
  }));
  intakeConversation.dailySummaryEntryIds ||= {};
  let aiEntry = state.entries.find((item) => item.id === intakeConversation.dailySummaryEntryIds[day]);
  if (aiEntry?.status === "superseded") aiEntry = null;
  if (aiEntry) {
    aiEntry.title = dailySummary.title;
    aiEntry.sections = { summary: dailySummary.summary, plan: dailySummary.plan };
    aiEntry.spans = dailySpans;
    aiEntry.generatedAt = nowIso();
    aiEntry.extractedConcepts = analysis.concepts;
    aiEntry.aiProvider = dailySummary.provider;
    aiEntry.aiModel = dailySummary.model;
    aiEntry.version += 1;
  } else {
    aiEntry = {
      id: `E-${state.entries.length + 1}`,
      patientId: input.patientId,
      clinicId: actor.clinicId,
      authorRole: "system",
      authorId: "ai-scribe",
      type: "ai_patient_session_summary",
      occurredAt: dailyMessages[0].createdAt,
      generatedAt: nowIso(),
      visibility: "clinical_team",
      status: "needs_review",
      sections: { summary: analysis.summary, plan: analysis.plan },
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
    Object.assign(highlight, highlightFields);
  } else {
    highlight = {
      id: `H-${state.highlights.length + 1}`,
      patientId: input.patientId,
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
    body: String(body).trim(),
    redactedBody: String(redactedBody).trim(),
    createdAt: nowIso(),
    ...metadata
  };
  conversation.messages.push(message);
  return message;
}

export function conversationView(patientId, actor) {
  return state.conversations
    .filter((conversation) => conversation.patientId === patientId && conversation.participants.includes(actor.role))
    .map((conversation) => ({ ...conversation, messages: conversation.messages.map(({ redactedBody, ...message }) => message) }));
}

export async function sendConversationMessage(conversationId, body, redactedBody, actor) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return null;
  const message = addMessageRecord(conversation, body, redactedBody, actor);
  addAudit(actor, "conversation.message_sent", "conversation", conversation.id, { kind: conversation.kind });
  const created = [message];
  if (conversation.kind === "patient_ai" && actor.role === "patient") {
    const reply = await generateIntakeReply(conversation.messages);
    created.push(addMessageRecord(
      conversation,
      reply.body,
      reply.body,
      { role: "system", actorId: "intake-assistant", clinicId: actor.clinicId },
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
      clinicId: conversation.clinicId,
      authorRole: "system",
      authorId: "ai-scribe",
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
  const outcomeEntry = createEntry(
    {
      patientId: input.patientId,
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
  state.consultation = {
    patientId: input.patientId,
    status: "closed",
    closedAt: nowIso(),
    closedBy: actor.actorId,
    outcomeEntryId: outcomeEntry.id
  };
  addAudit(actor, "consultation.closed", "patient", input.patientId, { outcomeEntryId: outcomeEntry.id, prescriptionCount: prescriptions.length });
  return { outcomeEntry, prescriptions, consultation: state.consultation };
}

export function rejectAndReplaceHighlight(highlightId, input, actor) {
  const highlight = state.highlights.find((item) => item.id === highlightId);
  if (!highlight) return null;
  highlight.status = "rejected";
  highlight.decidedBy = actor.actorId;
  highlight.decidedAt = nowIso();
  state.feedbackWeights[highlight.category] =
    (state.feedbackWeights[highlight.category] || 0) - 10;
  const learnedWeight = state.feedbackWeights[highlight.category];
  addAudit(actor, "highlight.rejected_with_replacement", "highlight", highlightId, {
    category: highlight.category,
    reason: input.reason
  });

  const clinicalEntry = createEntry(
    {
      patientId: highlight.patientId,
      type: "confirmed_diagnosis",
      status: "clinician_confirmed",
      summary: input.diagnosis,
      plan: input.plan,
      supersedesEntryId: highlight.entryId
    },
    actor
  );
  const patientEntry = createEntry(
    {
      patientId: highlight.patientId,
      type: "patient_instruction",
      visibility: "patient",
      status: "active",
      summary: input.patientSummary,
      plan: input.patientPlan
    },
    actor
  );
  for (const task of state.tasks.filter((item) => item.sourceHighlightId === highlightId)) {
    if (task.status === "result_ready") {
      task.status = "reviewed";
      task.updatedBy = actor.actorId;
      task.updatedAt = nowIso();
    }
  }
  return {
    highlight: {
      ...highlight,
      learnedWeight,
      futureSimilarScore: highlight.baseScore + learnedWeight
    },
    clinicalEntry,
    patientEntry
  };
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
  if (firstDecision) {
    state.feedbackWeights[highlight.category] =
      (state.feedbackWeights[highlight.category] || 0) + 10;
  }
  const learnedWeight = state.feedbackWeights[highlight.category] || 0;
  addAudit(actor, "highlight.pinned_as_important", "highlight", highlightId, {
    category: highlight.category,
    learnedWeight,
    confirmsClinicalTruth: false
  });
  return {
    ...highlight,
    learnedWeight,
    futureSimilarScore: highlight.baseScore + learnedWeight
  };
}

export function createTask(input, actor) {
  const task = {
    id: `T-${state.tasks.length + 1}`,
    patientId: input.patientId,
    clinicId: actor.clinicId,
    title: input.title,
    rationale: input.rationale,
    resultType: input.resultType || "general_assessment",
    sourceHighlightId: input.sourceHighlightId,
    status: "to_do",
    createdBy: actor.actorId,
    createdAt: nowIso(),
    updatedBy: actor.actorId,
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
        type: task.resultType === "glucose_panel" ? "lab_result" : "assessment_result",
        status: "result_ready",
        summary: resultSummary,
        plan: "Await clinician interpretation."
      },
      actor
    );
    task.resultEntryId = resultEntry.id;
  }
  task.updatedBy = actor.actorId;
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
  const comment = {
    id: `C-${state.comments.length + 1}`,
    patientId: entry.patientId,
    clinicId: entry.clinicId,
    entryId,
    authorRole: actor.role,
    authorId: actor.actorId,
    body,
    mentions: [...body.matchAll(/@(\w+)/g)].map((match) => match[1]),
    resolved: false,
    createdAt: nowIso()
  };
  state.comments.push(comment);
  addAudit(actor, "comment.created", "comment", comment.id, { entryId });
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
  const entry = {
    id: `E-${state.entries.length + 1}`,
    patientId: input.patientId,
    clinicId: actor.clinicId,
    authorRole: actor.role,
    authorId: actor.actorId,
    type: input.type || `${actor.role}_note`,
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
