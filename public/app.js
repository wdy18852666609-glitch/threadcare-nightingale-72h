const loginView = document.querySelector("#loginView");
const appShell = document.querySelector("#appShell");
const topCards = document.querySelector("#topCards");
const timeline = document.querySelector("#timeline");
const notice = document.querySelector("#notice");
const careView = document.querySelector("#careView");
const adminView = document.querySelector("#adminView");
const patientPortal = document.querySelector("#patientPortal");
const patientListView = document.querySelector("#patientListView");
const staffTaskView = document.querySelector("#staffTaskView");
const drawer = document.querySelector("#sourceDrawer");
const drawerBackdrop = document.querySelector("#drawerBackdrop");

let account = null;
let view = null;
let currentPatientId = null;
let currentPage = "patients";
let startedAt = performance.now();

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const data = await response.json();
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    account = null;
    showLogin();
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function role() {
  return account?.role || "";
}

function showLogin() {
  closeDrawer();
  document.querySelector("#feedbackBackdrop").classList.add("hidden");
  appShell.classList.add("hidden");
  loginView.classList.remove("hidden");
}

function enterApp(signedInAccount) {
  account = signedInAccount;
  currentPatientId = account.patientId || currentPatientId;
  currentPage = { patient: "patient", clinician: "patients", staff: "patients", admin: "audit" }[role()];
  document.querySelector("#accountName").textContent = account.displayName;
  document.querySelector("#accountRole").textContent = `${roleLabel(role())}${account.patientId ? ` · ${account.patientId}` : account.username ? ` · ${account.username}` : ""} · server-verified session`;
  document.querySelectorAll("[data-nav]").forEach((button) => {
    const allowed = role() === "admin" ? ["audit"] : role() === "patient" ? ["care", "messages"] : role() === "staff" ? ["patients", "tasks", "messages", "care"] : ["patients", "care", "messages"];
    button.classList.toggle("hidden", !allowed.includes(button.dataset.nav));
  });
  loginView.classList.add("hidden");
  appShell.classList.remove("hidden");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;"
  }[character]));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-SG", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

function showNotice(message, kind = "info") {
  notice.textContent = message;
  notice.classList.remove("hidden");
  notice.style.background = kind === "error" ? "#feebe8" : "#fff4dd";
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => notice.classList.add("hidden"), 5000);
}

function roleLabel(role) {
  return { system: "AI Scribe", clinician: "Clinician", staff: "Staff", patient: "Patient" }[role] || role;
}

function renderConversation(containerId, conversation) {
  const container = document.querySelector(`#${containerId}`);
  if (!container) return;
  if (!conversation?.messages?.length) {
    container.innerHTML = `<div class="empty-state">No messages yet.</div>`;
    return;
  }
  container.innerHTML = conversation.messages.map((message) => {
    const mine = message.authorRole === role();
    const ai = message.authorRole === "system";
    return `<div class="message-bubble ${mine ? "mine" : ""} ${ai ? "ai" : ""}"><span>${escapeHtml(message.authorName || roleLabel(message.authorRole))} · ${formatDate(message.createdAt)}</span><p>${escapeHtml(message.body)}</p></div>`;
  }).join("");
  container.scrollTop = container.scrollHeight;
}

function bindConversation(containerId, conversation) {
  renderConversation(containerId, conversation);
  const panel = document.querySelector(`#${containerId}`)?.closest(".chat-panel");
  const form = panel?.querySelector("[data-conversation-form]");
  const summarize = panel?.querySelector("[data-summarize-conversation]");
  if (form) form.dataset.conversationForm = conversation?.id || "";
  if (summarize) summarize.dataset.summarizeConversation = conversation?.id || "";
}

function renderPatientTreatment() {
  const panel = document.querySelector("#patientTreatment");
  const outcome = view.entries.find((entry) => entry.type === "consultation_outcome");
  if (!outcome) {
    panel.innerHTML = `<div class="empty-state">No clinician-confirmed consultation result or prescription yet.</div>`;
    return;
  }
  const medicines = view.prescriptions.filter((medicine) => medicine.consultationId === outcome.consultationId);
  panel.innerHTML = `<div class="treatment-card"><span class="eyebrow">CLINICIAN-CONFIRMED PLAN · CONSULTATION ${escapeHtml(view.consultations?.find((item) => item.id === outcome.consultationId)?.sequence || "")}</span><h2>${escapeHtml(outcome.sections.summary)}</h2><p>${escapeHtml(outcome.sections.plan)}</p><div class="medicine-list">${medicines.length ? medicines.map((medicine) => `<div class="medicine-card"><strong>${escapeHtml(medicine.name)}</strong><span>${escapeHtml(medicine.dose)} · ${escapeHtml(medicine.frequency)}</span><span>${escapeHtml(medicine.instructions)}</span></div>`).join("") : `<span>No medication prescribed.</span>`}</div></div>`;
}

function renderPatientReminders() {
  const panel = document.querySelector("#patientReminders");
  const reminders = view.tasks.filter((task) => task.scheduledAt);
  if (!reminders.length) {
    panel.innerHTML = `<div class="empty-state">No scheduled test reminders yet.</div>`;
    return;
  }
  panel.innerHTML = reminders.map((task) => `
    <div class="treatment-card reminder-card">
      <span class="eyebrow">SCHEDULED TEST REMINDER</span>
      <h2>${escapeHtml(task.title)}</h2>
      <p><strong>${formatDate(task.scheduledAt)}</strong></p>
      <span class="status-pill ${task.status}">${escapeHtml(task.status.replaceAll("_", " "))}</span>
    </div>`).join("");
}

function taskResultText(task) {
  if (!task?.results) return "";
  return task.resultType === "glucose_panel"
    ? `fasting glucose ${task.results.fastingGlucose} mg/dL · HbA1c ${task.results.hba1c}%`
    : task.results.outcome;
}

function setHeader(title, subtitle, breadcrumb = "ThreadCare") {
  document.querySelector("#patientName").innerHTML = title;
  document.querySelector("#patientMeta").textContent = subtitle;
  document.querySelector(".breadcrumb").textContent = breadcrumb;
}

function hideAllViews() {
  [careView, adminView, patientPortal, patientListView, staffTaskView].forEach((element) => element.classList.add("hidden"));
  document.querySelectorAll("[data-nav]").forEach((button) => button.classList.toggle("active", button.dataset.nav === currentPage));
}

function renderPatientHeader() {
  setHeader(
    `${escapeHtml(view.patient.displayName.replace(" (synthetic)", ""))} <small>(synthetic)</small>`,
    `${view.patient.age} years · ${view.patient.pronouns} · Last visit ${view.patient.lastVisit}`,
    `Patients / ${view.patient.id}`
  );
}

function updatePatientConversationLabels() {
  const patientName = view?.patient?.displayName?.replace(" (synthetic)", "") || "Patient";
  const clinicianHeading = document.querySelector("#clinicianPatientChat")?.closest(".chat-panel")?.querySelector("h2");
  const staffHeading = document.querySelector("#staffPatientChat")?.closest(".chat-panel")?.querySelector("h2");
  if (clinicianHeading) clinicianHeading.textContent = `Dr Lee ↔ ${patientName}`;
  if (staffHeading) staffHeading.textContent = `${role() === "staff" ? account.displayName : "Nursing team"} ↔ ${patientName}`;
}

function renderTopCards(target = topCards) {
  const highlight = view.highlights.find((item) => item.consultationId === view.consultation?.id) || view.highlights[0];
  const linkedTask = highlight ? view.tasks.find((item) => item.sourceHighlightId === highlight.id) : null;
  const activeTask = view.tasks.find((item) => !["reviewed", "cancelled"].includes(item.status));
  const confirmedConclusion = view.entries.find((entry) => entry.type === "confirmed_diagnosis" && entry.consultationId === view.consultation?.id);

  const reviewRow = confirmedConclusion ? `
    <article class="attention-card risk">
      <div class="card-label"><span class="glance-icon">!</span>Condition</div>
      <h3>${escapeHtml(confirmedConclusion.sections.summary)}</h3>
      <div class="glance-controls"><span class="status-pill accepted">Clinician confirmed</span><span class="importance-score high">92</span></div>
    </article>` : highlight ? `
    <article class="attention-card review">
      <div class="card-label"><span class="glance-icon">?</span>${highlight.status === "accepted" ? "Pinned important" : "Needs review"}</div>
      <div class="attention-copy"><h3>${escapeHtml(highlight.title)}</h3><p class="risk-reason"><strong>Why surfaced:</strong> ${escapeHtml(highlight.riskReason)}</p></div>
      <div class="glance-controls">
        <button class="source-link" data-source="${highlight.entryId}" data-span="${highlight.spanId}">Source</button>
        ${role() === "clinician" && highlight.status !== "accepted" ? `<button class="button small" data-pin-highlight="${highlight.id}">Pin as important</button>` : ""}
        ${highlight.status === "accepted" ? `<span class="status-pill accepted">Pinned · not a diagnosis</span>` : ""}
        ${role() === "clinician" ? `<button class="button small danger" data-reject-replace="${highlight.id}">Reject & replace</button>` : ""}
        ${linkedTask && linkedTask.status !== "result_ready" ? `<span class="status-pill suggested">Testing ${linkedTask.status.replace("_", " ")}</span>` : ""}
        <button class="importance-score ${highlight.status === "accepted" ? "high" : "medium"}" data-importance-explain="${highlight.id}" title="Open the explainable score">${highlight.score}</button>
      </div>
    </article>` : `
    <article class="attention-card review"><div class="card-label"><span class="glance-icon">?</span>Needs review</div><h3>No new patient concern awaiting review</h3><div class="glance-controls"><span class="importance-score zero">0</span></div></article>`;

  const taskRow = activeTask ? `
    <article class="attention-card action">
      <div class="card-label"><span class="glance-icon">✓</span>${activeTask.status === "result_ready" ? "Results ready" : "Open action"}</div>
      <h3>${activeTask.status === "result_ready" ? `Synthetic result: ${escapeHtml(taskResultText(activeTask))}` : escapeHtml(activeTask.title)}</h3>
      <div class="glance-controls">
        ${activeTask.resultEntryId ? `<button class="source-link" data-event-entry="${activeTask.resultEntryId}">View result</button>` : ""}
        ${role() === "clinician" && highlight && !linkedTask ? `<button class="button small" data-create-task="${highlight.id}">Create staff task</button>` : ""}
        <span class="status-pill ${activeTask.status}">${activeTask.status.replace("_", " ")}</span>
        <span class="importance-score ${activeTask.status === "result_ready" ? "high" : "medium"}">${activeTask.status === "result_ready" ? 90 : activeTask.status === "to_do" ? 82 : 74}</span>
      </div>
    </article>` : `
    <article class="attention-card action"><div class="card-label"><span class="glance-icon">✓</span>Open action</div><h3>${role() === "clinician" && highlight && !linkedTask ? "Choose and assign the next staff action" : "No active clinical task"}</h3><div class="glance-controls">${role() === "clinician" && highlight && !linkedTask ? `<button class="button small" data-create-task="${highlight.id}">Create staff task</button>` : `<span class="status-pill">None</span><span class="importance-score zero">0</span>`}</div></article>`;

  const allergy = view.patient.allergies?.[0];
  const allergyRow = allergy ? `
    <article class="attention-card risk">
      <div class="card-label"><span class="glance-icon">!</span>Critical allergy</div>
      <h3>${escapeHtml(allergy.substance)} · ${escapeHtml(allergy.reaction)}</h3>
      <div class="glance-controls"><button class="source-link" data-event-entry="${allergy.sourceEntryId}">Source</button><span class="status-pill accepted">Confirmed</span><span class="importance-score high">98</span></div>
    </article>` : `
    <article class="attention-card risk"><div class="card-label"><span class="glance-icon">!</span>Critical allergy</div><h3>No confirmed critical allergy on record</h3><div class="glance-controls"><span class="status-pill">Not recorded</span><span class="importance-score zero">0</span></div></article>`;

  target.innerHTML = `${reviewRow}${taskRow}${allergyRow}`;
}

function renderTimeline(target = timeline) {
  // Patient submissions remain stored as the source of truth, but the AI-scribed
  // timeline card already links back to that exact source. Showing both cards
  // would represent one encounter twice in the clinical timeline.
  const timelineEntries = view.entries.filter((entry) => entry.type !== "patient_message");
  if (!timelineEntries.length) {
    target.innerHTML = `<div class="empty-state">No entries are visible to this role.</div>`;
    return;
  }
  const chronologicalEntries = [...timelineEntries].reverse();
  const coldEntries = chronologicalEntries.filter((entry) => entry.storage?.tier === "cold");
  const activeEntries = chronologicalEntries.filter((entry) => entry.storage?.tier !== "cold");
  const renderEntry = (entry) => {
    const comments = view.comments.filter((comment) => comment.entryId === entry.id);
    const consultation = view.consultations?.find((item) => item.id === entry.consultationId);
    const date = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", year: "2-digit" }).format(new Date(entry.occurredAt));
    const storageBadge = entry.storage?.tier === "warm" ? `<span class="storage-badge warm" title="${escapeHtml(entry.storage.reason)}">Warm context</span>` : "";
    return `
      <article class="timeline-entry ${entry.status === "superseded" ? "superseded" : ""}" id="entry-${entry.id}">
        <div class="timeline-node-row"><span class="timeline-date">${date}</span><span class="timeline-dot"></span></div>
        <div class="timeline-connector"></div>
        <div class="entry-card" data-event-entry="${entry.id}">
          <div class="entry-meta"><span><strong>${escapeHtml(entry.authorName || roleLabel(entry.authorRole))}</strong></span><span>${consultation ? `Consultation ${consultation.sequence} · ` : ""}${escapeHtml(entry.status.replaceAll("_", " "))}</span></div>
          <h3>${escapeHtml(entry.sections.summary)}</h3>
          <div class="entry-actions"><span class="entry-hint">Open details & comments →</span>${storageBadge}${comments.length ? `<span class="status-pill">${comments.length} comment${comments.length > 1 ? "s" : ""}</span>` : ""}</div>
        </div>
      </article>`;
  };
  const archiveCard = coldEntries.length ? `
    <article class="timeline-entry archive-entry">
      <div class="timeline-node-row"><span class="timeline-date">ARCHIVE</span><span class="timeline-dot"></span></div>
      <div class="timeline-connector"></div>
      <button class="entry-card archive-card" data-open-archive>
        <div class="entry-meta"><span><strong>Compressed history</strong></span><span>Cold tier</span></div>
        <h3>${coldEntries.length} older low-priority ${coldEntries.length === 1 ? "record" : "records"}</h3>
        <p>Collapsed for glanceability. Exact entries, versions and sources remain available.</p>
        <div class="entry-actions"><span class="entry-hint">View retained sources →</span><span class="storage-badge cold">No deletion</span></div>
      </button>
    </article>` : "";
  target.innerHTML = `${archiveCard}${activeEntries.map(renderEntry).join("")}`;
}

async function renderCareNote() {
  if (!currentPatientId) { currentPage = "patients"; return renderPatientList(); }
  hideAllViews();
  careView.classList.remove("hidden");
  startedAt = performance.now();
  view = await api(`/api/patients/${currentPatientId}`);
  updatePatientConversationLabels();
  renderPatientHeader();
  renderTopCards();
  renderTimeline();
  const closed = view.consultation?.status === "closed";
  const active = view.consultation?.status === "open" && view.consultation?.activityStarted !== false;
  const conversations = active ? await api(`/api/conversations?patientId=${encodeURIComponent(currentPatientId)}`) : [];
  if (active) {
    bindConversation("clinicianPatientChat", conversations.find((item) => item.kind === "patient_clinician"));
    bindConversation("clinicianTeamChat", conversations.find((item) => item.kind === "clinical_team"));
  }
  document.querySelector("#clinicianPatientPanel").classList.toggle("hidden", role() !== "clinician");
  document.querySelector("#clinicianCommunication").classList.toggle("hidden", !active || role() !== "clinician");
  document.querySelector("#closeConsultationButton").classList.toggle("hidden", role() !== "clinician" || !active);
  const addNoteButton = document.querySelector("#addNoteButton");
  addNoteButton.classList.toggle("hidden", role() !== "clinician" || !active);
  addNoteButton.textContent = "Add clinician note";
  const consultationState = document.querySelector("#consultationState");
  consultationState.classList.toggle("hidden", active);
  consultationState.innerHTML = closed
    ? `<strong>Consultation ${view.consultation.sequence} complete</strong><span>The result remains in the longitudinal timeline.</span>${role() === "clinician" ? `<button class="button" data-start-consultation>Start next consultation</button>` : ""}`
    : !active
      ? `<strong>No active consultation</strong><span>The longitudinal record is ready. A patient pre-consult or clinician action can begin the next consultation.</span>${role() === "clinician" ? `<button class="button" data-start-consultation>Start consultation</button>` : ""}`
      : "";
  document.querySelector("#loadTime").textContent = `${Math.max(1, Math.round(performance.now() - startedAt))}ms observed`;
}

async function renderPatientPortal() {
  hideAllViews();
  patientPortal.classList.remove("hidden");
  view = await api(`/api/patients/${currentPatientId}`);
  const conversations = await api(`/api/conversations?patientId=${encodeURIComponent(currentPatientId)}`);
  const closed = view.consultation?.status === "closed";
  const active = view.consultation?.status === "open" && view.consultation?.activityStarted !== false;
  const sequence = view.consultation?.sequence || 1;
  setHeader(closed ? `Consultation ${sequence} complete` : `Consultation ${sequence} pre-consult`, closed ? "Your previous result remains below. Start a new pre-consult whenever you need care again." : "Share symptoms and questions before your visit", `Patient portal / ${view.patient.displayName.replace(" (synthetic)", "")}`);
  document.querySelector("#patientConsultTitle").textContent = closed ? "Start your next consultation" : `Consultation ${sequence} · AI-assisted pre-consult`;
  document.querySelector("#patientConsultDescription").textContent = closed ? "Describe a new concern below. Submitting it will open a new consultation without deleting your history." : "Describe what you are feeling. AI will organise the report and ask a follow-up question; it does not diagnose you.";
  document.querySelector(".patient-communications").classList.toggle("hidden", !active);
  bindConversation("patientAiChat", conversations.find((item) => item.kind === "patient_ai"));
  bindConversation("patientClinicianChat", conversations.find((item) => item.kind === "patient_clinician"));
  bindConversation("patientStaffChat", conversations.find((item) => item.kind === "nurse_patient"));
  renderPatientTreatment();
  renderPatientReminders();
  document.querySelector("#feedbackBackdrop").classList.toggle("hidden", view.consultation?.status !== "closed" || Boolean(view.consultation?.feedback));
}

async function renderPatientList() {
  hideAllViews();
  patientListView.classList.remove("hidden");
  const patients = await api("/api/patients");
  const isStaff = role() === "staff";
  setHeader("Patient queue", "Select a patient to open the shared longitudinal care note", isStaff ? "Staff workspace" : "Clinician workspace");
  document.querySelector("#patientList").innerHTML = patients.map((patient) => `
    <article class="patient-row">
      <div><span class="eyebrow">${isStaff ? "STAFF PATIENT ACCESS" : "CLINICIAN PATIENT ACCESS"}</span><h3>${escapeHtml(patient.displayName)}</h3><p>${patient.age} years · ${escapeHtml(patient.pronouns)} · Last visit ${escapeHtml(patient.lastVisit)}</p>${patient.needsReviewCount ? `<span class="patient-alert">● ${patient.needsReviewCount} new item${patient.needsReviewCount > 1 ? "s" : ""} need review</span>` : patient.openTaskCount ? `<span class="patient-alert">● ${patient.openTaskCount} open staff task${patient.openTaskCount > 1 ? "s" : ""}</span>` : `<span class="patient-alert" style="color:var(--muted)">No new patient concern</span>`}</div>
      <button class="button patient-open-button" data-open-patient="${patient.id}">Open care note</button>
    </article>`).join("");
}

async function renderStaffTasks() {
  if (!currentPatientId) { currentPage = "patients"; return renderPatientList(); }
  hideAllViews();
  staffTaskView.classList.remove("hidden");
  view = await api(`/api/patients/${currentPatientId}`);
  updatePatientConversationLabels();
  const tasks = await api(`/api/tasks?patientId=${encodeURIComponent(currentPatientId)}`);
  setHeader(view.patient.displayName.replace(" (synthetic)", ""), `${view.patient.age} years · ${view.patient.pronouns} · Shared staff care view`, `Staff workspace / Patients / ${view.patient.id}`);
  renderTopCards(document.querySelector("#staffTopCards"));
  renderTimeline(document.querySelector("#staffTimeline"));
  document.querySelector("#staffTasks").innerHTML = tasks.length ? tasks.map((task) => `
    <article class="task-row"><div><span class="eyebrow">${escapeHtml(task.status.replace("_", " "))}</span><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.rationale)}</p><p><strong>Created by:</strong> ${escapeHtml(task.createdByName || task.createdBy)} · <strong>Last handled by:</strong> ${escapeHtml(task.updatedByName || task.updatedBy)}</p>${task.scheduledAt ? `<p><strong>Scheduled:</strong> ${formatDate(task.scheduledAt)}</p>` : ""}${task.results ? `<div class="result-panel">Recorded result: ${escapeHtml(taskResultText(task))}</div>` : ""}</div><div class="card-actions">${task.status === "to_do" ? `<button class="button" data-schedule-task="${task.id}">Set test time</button>` : ""}${task.status === "scheduled" ? `<button class="button" data-complete-task="${task.id}">Complete & add results</button>` : ""}<span class="status-pill ${task.status}">${escapeHtml(task.status.replace("_", " "))}</span></div></article>`).join("") : `<div class="empty-state">Tasks created by clinicians will appear here.</div>`;
  const conversations = await api(`/api/conversations?patientId=${encodeURIComponent(currentPatientId)}`);
  bindConversation("staffTeamChat", conversations.find((item) => item.kind === "clinical_team"));
  bindConversation("staffPatientChat", conversations.find((item) => item.kind === "nurse_patient"));
  const active = view.consultation?.status === "open" && view.consultation?.activityStarted !== false;
  document.querySelectorAll("#staffTaskView .team-chat-panel").forEach((panel) => panel.classList.toggle("hidden", !active));
}

async function renderAdmin() {
  hideAllViews();
  adminView.classList.remove("hidden");
  setHeader("Clinic audit", "Metadata-only activity log", "Admin workspace");
  const events = await api("/api/audit");
  adminView.innerHTML = `
    <div class="demo-reset-card">
      <div><span class="eyebrow">DEMO CONTROL</span><h2>Restore the final starting state</h2><p>Returns the prototype to Mr Chen with concise longitudinal history and Ms Taylor as a clean new patient. Test results, tasks, prescriptions, comments and learned weights are cleared.</p></div>
      <button class="button danger" data-reset-demo>Restore demo</button>
    </div>
    <div class="section-heading"><div><span class="eyebrow">METADATA ONLY</span><h2>Clinic audit log</h2></div></div>${events.length ? `<table class="audit-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th></tr></thead><tbody>${events.map((event) => `<tr><td>${formatDate(event.at)}</td><td>${escapeHtml(event.actorRole)} · ${escapeHtml(event.actorId)}</td><td>${escapeHtml(event.action)}</td><td>${escapeHtml(event.resourceType)} · ${escapeHtml(event.resourceId)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty-state">No actions yet. Audit logs store metadata, not note contents.</div>`}`;
}

async function loadView() {
  if (role() === "patient") return renderPatientPortal();
  if (role() === "staff") return currentPage === "staff-care" ? renderStaffTasks() : renderPatientList();
  if (role() === "admin") return renderAdmin();
  if (currentPage === "care" && currentPatientId) return renderCareNote();
  return renderPatientList();
}

function showDrawer(content, title = "Entry details") {
  document.querySelector("#drawerTitle").textContent = title;
  document.querySelector("#drawerContent").innerHTML = content;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.classList.remove("hidden");
  installVoiceInputs(drawer);
}

function closeDrawer() {
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.classList.add("hidden");
}

let activeVoiceRecording = null;

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function stopVoiceRecording() {
  const recording = activeVoiceRecording;
  if (!recording) return;
  activeVoiceRecording = null;
  clearTimeout(recording.timer);
  recording.processor.disconnect();
  recording.source.disconnect();
  recording.stream.getTracks().forEach((track) => track.stop());
  const sampleRate = recording.context.sampleRate;
  await recording.context.close();
  recording.button.classList.remove("recording");
  recording.button.disabled = true;
  recording.button.textContent = "Transcribing…";
  try {
    const length = recording.chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (length < sampleRate / 5) throw new Error("The recording was too short. Please speak for at least one second.");
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of recording.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    if (rms < 0.003) throw new Error("No clear speech was detected. Please check your microphone and try again.");
    const audio = encodeWav(samples, sampleRate);
    const result = await api("/api/transcriptions", {
      method: "POST",
      body: JSON.stringify({ audioBase64: await blobToBase64(audio), mimeType: "audio/wav", patientId: currentPatientId })
    });
    const existing = recording.target.value.trim();
    recording.target.value = `${existing}${existing ? " " : ""}${result.transcript}`;
    recording.target.dispatchEvent(new Event("input", { bubbles: true }));
    recording.target.focus();
    showNotice("Voice converted to text. Review it before sending.");
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    recording.button.disabled = false;
    recording.button.textContent = "🎙 Voice";
  }
}

async function toggleVoiceRecording(target, button) {
  if (activeVoiceRecording) {
    if (activeVoiceRecording.button === button) return stopVoiceRecording();
    showNotice("Stop the current recording before starting another.", "error");
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showNotice("Microphone access requires HTTPS or http://localhost:3000. The LAN HTTP address cannot request microphone permission.", "error");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(processor);
    processor.connect(context.destination);
    activeVoiceRecording = { target, button, stream, context, source, processor, chunks, timer: null };
    activeVoiceRecording.timer = setTimeout(() => stopVoiceRecording(), 30_000);
    button.classList.add("recording");
    button.textContent = "■ Stop";
    showNotice("Recording… click Stop when you finish. Maximum 30 seconds.");
  } catch (error) {
    showNotice(error.name === "NotAllowedError" ? "Microphone permission was not granted." : "The microphone could not be started.", "error");
  }
}

function installVoiceInputs(root = document) {
  const selector = root === drawer ? "textarea" : "#patientSessionForm textarea[name='message'], .chat-form input[name='body']";
  const targets = root.querySelectorAll(selector);
  targets.forEach((target) => {
    if (target.dataset.voiceReady) return;
    target.dataset.voiceReady = "true";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary voice-button";
    button.textContent = "🎙 Voice";
    button.setAttribute("aria-label", "Record voice and convert it to text");
    button.addEventListener("click", () => toggleVoiceRecording(target, button));
    target.insertAdjacentElement("afterend", button);
  });
}

async function openSource(entryId, spanId) {
  const timelineEntry = document.querySelector(`#entry-${CSS.escape(entryId)}`);
  if (timelineEntry) {
    timelineEntry.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    timelineEntry.classList.add("source-focus");
    setTimeout(() => timelineEntry.classList.remove("source-focus"), 2200);
  }
  const source = await api(`/api/entries/${entryId}/source`);
  const span = source.spans.find((item) => item.id === spanId) || source.spans[0];
  const isConversationSource = source.spans.some((item) => item.messageId);
  const transcript = isConversationSource
    ? source.spans.map((item) => `<div class="message-bubble ${item.authorRole === "system" ? "ai" : ""}"><span>${escapeHtml(item.authorName || roleLabel(item.authorRole))} · ${item.occurredAt ? formatDate(item.occurredAt) : "Source message"}</span><p>${escapeHtml(item.messageBody || item.text)}</p></div>`).join("")
    : `<div class="transcript"><span class="timestamp">${span?.occurredAt ? formatDate(span.occurredAt) : span?.startSeconds !== undefined ? `${span.startSeconds}s–${span.endSeconds ?? "end"}` : "Source message"}</span><p>${span ? `<mark>${escapeHtml(span.text)}</mark>` : "No transcript span attached."}</p></div>`;
  showDrawer(`<div class="source-meta"><div><span>Interaction</span><strong>${escapeHtml(source.interactionType.replaceAll("_", " "))}</strong></div><div><span>Generated by</span><strong>${escapeHtml(source.authorRole)}</strong></div><div><span>Occurred</span><strong>${formatDate(source.occurredAt)}</strong></div><div><span>Generated</span><strong>${source.generatedAt ? formatDate(source.generatedAt) : "Manual entry"}</strong></div></div>${isConversationSource ? `<div class="message-list source-chat">${transcript}</div>` : transcript}<p class="patient-meta">The server verified role and clinic scope before returning this source.</p>`, isConversationSource ? "Full conversation source" : "Exact source");
}

function openEntryDiscussion(entryId) {
  const entry = view.entries.find((item) => item.id === entryId);
  if (!entry) return;
  const comments = view.comments.filter((comment) => comment.entryId === entryId);
  const sourceLabel = entry.spans.some((item) => item.messageId) ? "View full conversation source" : "View exact source";
  const canEditOwnNote = ["staff", "clinician"].includes(role()) && entry.authorRole === role();
  showDrawer(`<div class="source-meta"><div><span>Author</span><strong>${escapeHtml(entry.authorName || roleLabel(entry.authorRole))}</strong></div><div><span>Status</span><strong>${escapeHtml(entry.status.replaceAll("_", " "))}</strong></div><div><span>Date</span><strong>${formatDate(entry.occurredAt)}</strong></div><div><span>Version</span><strong>v${entry.version}</strong></div></div><div class="transcript"><span class="eyebrow">SUMMARY</span><p>${escapeHtml(entry.sections.summary)}</p><span class="eyebrow">PLAN</span><p>${escapeHtml(entry.sections.plan)}</p></div><div class="entry-actions">${entry.spans.length ? `<button class="button small secondary" data-source="${entry.id}" data-span="${entry.spans[0].id}">${sourceLabel}</button>` : ""}${canEditOwnNote ? `<button class="button small secondary" data-edit-entry="${entry.id}">Edit plan</button><button class="button small secondary" data-history-entry="${entry.id}">Version history</button>` : ""}</div><div style="margin-top:18px"><span class="eyebrow">COMMENTS · ${comments.length}</span>${comments.length ? comments.map((comment) => `<div class="comment-box"><span><strong>${escapeHtml(comment.authorName || comment.authorRole)}</strong> · ${escapeHtml(comment.body)} ${comment.resolved ? "· ✓ resolved" : ""}</span>${["staff", "clinician"].includes(role()) ? `<button class="source-link" data-comment-toggle="${comment.id}" data-resolved="${!comment.resolved}">${comment.resolved ? "Reopen" : "Resolve"}</button>` : ""}</div>`).join("") : `<p class="patient-meta">No comments on this event.</p>`}${["staff", "clinician"].includes(role()) ? `<form class="inline-form" data-comment-form="${entry.id}"><input name="body" placeholder="Comment with @clinician…" required><button class="button small">Add</button></form>` : ""}</div>`, "Event discussion");
}

function openLabResultForm(taskId) {
  showDrawer(`<p class="patient-meta">Enter the result yourself. Staff records what was observed; only a clinician interprets it.</p><form class="lab-form" data-lab-form="${taskId}"><label>Test result<textarea name="outcome" placeholder="Enter the completed test result…" required></textarea></label><button class="button">Complete task and publish result</button></form>`, "Complete assigned task");
}

function openTaskForm(highlightId) {
  showDrawer(`<p class="patient-meta">The AI does not choose the test. Enter the staff task and instructions yourself.</p><form class="task-form" data-create-task-form="${highlightId}"><label>Test or task<input name="title" placeholder="e.g. Name of the test to arrange" required></label><label>Instructions for staff<textarea name="rationale" placeholder="What should staff arrange or confirm?" required></textarea></label><button class="button">Send task to staff</button></form>`, "Create staff task");
}

function openScheduleForm(taskId) {
  showDrawer(`<p class="patient-meta">Choose the confirmed test time. The patient will receive a reminder containing the task and this time.</p><form class="schedule-form" data-schedule-task-form="${taskId}"><label>Test date and time<input type="datetime-local" name="scheduledAt" required></label><button class="button">Schedule and notify patient</button></form>`, "Schedule test");
}

function openManualNoteForm() {
  const noteRole = role();
  if (!["staff", "clinician"].includes(noteRole)) return;
  showDrawer(`<p class="patient-meta">This note will be owned by ${escapeHtml(roleLabel(noteRole))}. Other roles may read it but cannot edit or revert it.</p><form class="manual-note-form" data-manual-note-form><label>Note summary<textarea name="summary" placeholder="Enter the observed update…" required></textarea></label><label>Plan or follow-up<textarea name="plan" placeholder="Enter the next step…"></textarea></label><button class="button">Add ${escapeHtml(noteRole)} note to timeline</button></form>`, `Add ${roleLabel(noteRole)} note`);
}

function openCloseConsultationForm() {
  showDrawer(`<p class="patient-meta">Only the clinician can enter the final result, advice and any prescription. Nothing is pre-filled.</p><form class="consultation-form" data-close-consultation><label>Clinician assessment<textarea name="assessment" placeholder="Enter the consultation result…" required></textarea></label><label>Advice for the patient<textarea name="advice" placeholder="Enter the patient-facing advice…" required></textarea></label><span class="eyebrow">PRESCRIPTION · OPTIONAL</span><label>Medication<input name="medicine" placeholder="Leave blank if no medication is prescribed"></label><label>Dose<input name="dose" placeholder="Dose"></label><label>Frequency<input name="frequency" placeholder="Frequency"></label><label>Instructions<textarea name="instructions" placeholder="Medication instructions"></textarea></label><button class="button">Confirm result & end consultation</button></form>`, "End consultation");
}

function openReplacementForm(highlightId) {
  const task = view.tasks.find((item) => item.sourceHighlightId === highlightId && item.status === "result_ready");
  showDrawer(`${task ? `<div class="result-panel">Recorded evidence: ${escapeHtml(taskResultText(task))}</div>` : ""}<p class="patient-meta">Reject the unconfirmed suggestion and enter the clinician-authored assessment. Final advice and medication belong in End consultation.</p><form class="replacement-form" data-replacement-form="${highlightId}"><label>Reason for rejection<textarea name="reason" placeholder="Why is the original suggestion being rejected?" required></textarea></label><label>Replacement / clinician assessment<textarea name="diagnosis" placeholder="Enter the clinician's assessment…" required></textarea></label><button class="button danger">Reject old suggestion & update timeline</button></form>`, "Reject and replace");
}

function openEntryEditor(entryId) {
  const entry = view.entries.find((item) => item.id === entryId);
  if (!entry) return;
  showDrawer(`<p class="patient-meta">Saving creates a new immutable version.</p><form class="editor-form" data-editor-form="${entry.id}" data-base-version="${entry.version}"><label><span class="eyebrow">PLAN · CURRENT V${entry.version}</span><textarea name="content" required>${escapeHtml(entry.sections.plan)}</textarea></label><button class="button">Save as version ${entry.version + 1}</button></form>`, "Edit clinical plan");
}

async function openVersionHistory(entryId) {
  const versions = (await api("/api/versions")).filter((item) => item.entryId === entryId).reverse();
  const entry = view.entries.find((item) => item.id === entryId);
  showDrawer(`<p class="patient-meta">Current version: v${entry?.version || "—"}.</p>${versions.length ? versions.map((version) => `<div class="version-item"><span class="eyebrow">VERSION ${version.version} · ${escapeHtml(version.section)}</span><p><del>${escapeHtml(version.previous)}</del></p><p><ins>${escapeHtml(version.current)}</ins></p><p>${escapeHtml(version.changedBy)} · ${formatDate(version.changedAt)}</p><button class="button small secondary" data-revert-entry="${entryId}" data-target-version="${version.version - 1}">Revert to v${version.version - 1}</button></div>`).join("") : `<div class="empty-state">No edits yet.</div>`}`, "Version history");
}

function openImportanceExplanation(highlightId) {
  const highlight = view.highlights.find((item) => item.id === highlightId);
  if (!highlight) return;
  const breakdown = highlight.breakdown || {};
  const rows = [
    ["AI suggestion base", breakdown.base || 0],
    ["Explicit risk tag", breakdown.explicitRisk || 0],
    ["Recent change", breakdown.recency || 0],
    ["Unresolved action", breakdown.unresolvedAction || 0],
    ["Team-learned priority", breakdown.teamLearning || 0]
  ];
  const signals = highlight.matchedSignals?.length
    ? highlight.matchedSignals.map((item) => `<span class="learning-signal">${escapeHtml(item.label)} <strong>${item.weight > 0 ? "+" : ""}${item.weight}</strong></span>`).join("")
    : `<span class="patient-meta">No prior team feedback matches this suggestion yet.</span>`;
  showDrawer(`
    <div class="importance-total"><span>Current priority</span><strong>${highlight.score}</strong></div>
    <div class="score-breakdown">${rows.map(([label, value]) => `<div><span>${label}</span><strong>${value > 0 ? "+" : ""}${value}</strong></div>`).join("")}</div>
    <span class="eyebrow">MATCHED LEARNING SIGNALS</span>
    <div class="learning-signals">${signals}</div>
    <div class="trust-note"><strong>Ranking, not diagnosis.</strong> ${escapeHtml(highlight.policy || "Team feedback changes visibility only and never confirms clinical truth.")}</div>`,
  "Why this score?");
}

function openCompressedArchive() {
  const entries = view.entries
    .filter((entry) => entry.type !== "patient_message" && entry.storage?.tier === "cold")
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  showDrawer(`
    <div class="trust-note"><strong>Nothing was deleted.</strong> Older resolved context is collapsed to keep the consult view readable. Every exact entry, source pointer, version and audit event remains retrievable.</div>
    ${entries.map((entry) => `<button class="archive-source" data-event-entry="${entry.id}"><span><strong>${escapeHtml(entry.sections.summary)}</strong><small>${formatDate(entry.occurredAt)} · ${escapeHtml(entry.authorName || roleLabel(entry.authorRole))}</small></span><span>Open exact record →</span></button>`).join("")}`,
  "Compressed history · retained sources");
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-nav]");
  const openPatient = event.target.closest("[data-open-patient]");
  const sourceButton = event.target.closest("[data-source]");
  const pinButton = event.target.closest("[data-pin-highlight]");
  const createTaskButton = event.target.closest("[data-create-task]");
  const rejectButton = event.target.closest("[data-reject-replace]");
  const scheduleTaskButton = event.target.closest("[data-schedule-task]");
  const completeTaskButton = event.target.closest("[data-complete-task]");
  const commentToggle = event.target.closest("[data-comment-toggle]");
  const editButton = event.target.closest("[data-edit-entry]");
  const historyButton = event.target.closest("[data-history-entry]");
  const revertButton = event.target.closest("[data-revert-entry]");
  const eventCard = event.target.closest("[data-event-entry]");
  const summarizeButton = event.target.closest("[data-summarize-conversation]");
  const closeConsultationButton = event.target.closest("#closeConsultationButton");
  const startConsultationButton = event.target.closest("[data-start-consultation]");
  const addNoteButton = event.target.closest("#addNoteButton, [data-open-manual-note]");
  const importanceButton = event.target.closest("[data-importance-explain]");
  const archiveButton = event.target.closest("[data-open-archive]");
  const resetDemoButton = event.target.closest("[data-reset-demo]");
  try {
    if (nav) {
      closeDrawer();
      currentPage = nav.dataset.nav;
      if (currentPage === "messages") {
        if (role() === "patient") return renderPatientPortal();
        if (role() === "staff") { currentPage = "staff-care"; return renderStaffTasks(); }
        if (role() === "clinician") return renderCareNote();
      }
      if (role() === "clinician" && currentPage === "patients") return renderPatientList();
      if (role() === "staff" && currentPage === "tasks") { currentPage = currentPatientId ? "staff-care" : "patients"; return loadView(); }
      if (role() === "admin" && currentPage === "audit") return renderAdmin();
      if (role() === "clinician" && currentPage === "care" && currentPatientId) return renderCareNote();
      if (role() === "staff" && currentPage === "care" && currentPatientId) { currentPage = "staff-care"; return renderStaffTasks(); }
      return loadView();
    }
    if (openPatient) {
      currentPatientId = openPatient.dataset.openPatient;
      if (role() === "staff") { currentPage = "staff-care"; return renderStaffTasks(); }
      currentPage = "care";
      return renderCareNote();
    }
    if (sourceButton) return openSource(sourceButton.dataset.source, sourceButton.dataset.span);
    if (importanceButton) return openImportanceExplanation(importanceButton.dataset.importanceExplain);
    if (archiveButton) return openCompressedArchive();
    if (resetDemoButton) {
      if (!window.confirm("Restore the final demo starting state? Current synthetic test activity will be cleared.")) return;
      const result = await api("/api/admin/reset-demo", { method: "POST", body: "{}" });
      showNotice(`Demo restored: ${result.patientCount} synthetic patients and ${result.entryCount} seeded history entries.`);
      return renderAdmin();
    }
    if (pinButton) {
      await api(`/api/highlights/${pinButton.dataset.pinHighlight}/pin`, { method: "POST", body: "{}" });
      showNotice("Pinned as important. This trains priority, but does not confirm the patient's hypothesis as clinical truth.");
      return renderCareNote();
    }
    if (addNoteButton) return openManualNoteForm();
    if (createTaskButton) return openTaskForm(createTaskButton.dataset.createTask);
    if (rejectButton) return openReplacementForm(rejectButton.dataset.rejectReplace);
    if (scheduleTaskButton) return openScheduleForm(scheduleTaskButton.dataset.scheduleTask);
    if (completeTaskButton) return openLabResultForm(completeTaskButton.dataset.completeTask);
    if (editButton) return openEntryEditor(editButton.dataset.editEntry);
    if (historyButton) return openVersionHistory(historyButton.dataset.historyEntry);
    if (revertButton) {
      await api(`/api/entries/${revertButton.dataset.revertEntry}/revert`, { method: "POST", body: JSON.stringify({ targetVersion: Number(revertButton.dataset.targetVersion) }) });
      closeDrawer();
      return renderCareNote();
    }
    if (commentToggle) {
      const entryId = view.comments.find((item) => item.id === commentToggle.dataset.commentToggle)?.entryId;
      await api(`/api/comments/${commentToggle.dataset.commentToggle}`, { method: "PATCH", body: JSON.stringify({ resolved: commentToggle.dataset.resolved === "true" }) });
      await renderCareNote();
      return openEntryDiscussion(entryId);
    }
    if (eventCard) return openEntryDiscussion(eventCard.dataset.eventEntry);
    if (summarizeButton) {
      await api(`/api/conversations/${summarizeButton.dataset.summarizeConversation}/summarize`, { method: "POST", body: "{}" });
      showNotice("External LLM summary added to the longitudinal timeline with message-level sources.");
      return role() === "staff" ? renderStaffTasks() : renderCareNote();
    }
    if (startConsultationButton) {
      await api("/api/consultations/start", { method: "POST", body: JSON.stringify({ patientId: currentPatientId, trigger: "clinician_manual" }) });
      showNotice("A new consultation has started. Previous records remain in the timeline.");
      return renderCareNote();
    }
    if (closeConsultationButton) return openCloseConsultationForm();
  } catch (error) { showNotice(error.message, "error"); }
});

document.addEventListener("submit", async (event) => {
  const patientSession = event.target.id === "patientSessionForm";
  const labTaskId = event.target.dataset.labForm;
  const replacementId = event.target.dataset.replacementForm;
  const editorEntryId = event.target.dataset.editorForm;
  const commentEntryId = event.target.dataset.commentForm;
  const conversationId = event.target.dataset.conversationForm;
  const closeConsultation = event.target.hasAttribute("data-close-consultation");
  const createTaskHighlightId = event.target.dataset.createTaskForm;
  const scheduleTaskId = event.target.dataset.scheduleTaskForm;
  const manualNote = event.target.hasAttribute("data-manual-note-form");
  const consultationFeedback = event.target.id === "feedbackForm";
  if (!patientSession && !labTaskId && !replacementId && !editorEntryId && !commentEntryId && !conversationId && !closeConsultation && !createTaskHighlightId && !scheduleTaskId && !manualNote && !consultationFeedback) return;
  event.preventDefault();
  if (event.target.dataset.submitting === "true") return;
  event.target.dataset.submitting = "true";
  const submitButton = event.submitter || event.target.querySelector("button[type='submit'], button:not([type])");
  const submitLabel = submitButton?.textContent;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = labTaskId ? "Publishing result…" : "Saving…";
  }
  const data = new FormData(event.target);
  try {
    if (patientSession) {
      const result = await api("/api/patient-sessions", { method: "POST", body: JSON.stringify({ patientId: currentPatientId, message: data.get("message"), knownNames: [view.patient.displayName.replace(" (synthetic)", "")] }) });
      showNotice(result.acknowledgement);
      event.target.reset();
      return renderPatientPortal();
    }
    if (conversationId) {
      await api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ body: data.get("body"), knownNames: [view.patient.displayName.replace(" (synthetic)", "")] }) });
      event.target.reset();
      if (role() === "patient") return renderPatientPortal();
      if (role() === "staff") return currentPage === "staff-care" ? renderStaffTasks() : renderPatientList();
      return renderCareNote();
    }
    if (manualNote) {
      await api("/api/entries", { method: "POST", body: JSON.stringify({ patientId: currentPatientId, summary: data.get("summary"), plan: data.get("plan") }) });
      closeDrawer();
      showNotice(`${roleLabel(role())} note added. Only its author role can edit or revert it.`);
      currentPage = "care";
      return renderCareNote();
    }
    if (createTaskHighlightId) {
      await api("/api/tasks", { method: "POST", body: JSON.stringify({ patientId: currentPatientId, title: data.get("title"), rationale: data.get("rationale"), resultType: "general_assessment", sourceHighlightId: createTaskHighlightId }) });
      closeDrawer();
      showNotice("Your task was sent to staff. No test content was chosen by AI.");
      return renderCareNote();
    }
    if (scheduleTaskId) {
      await api(`/api/tasks/${scheduleTaskId}`, { method: "PATCH", body: JSON.stringify({ status: "scheduled", scheduledAt: data.get("scheduledAt") }) });
      closeDrawer();
      showNotice("Test scheduled. The patient reminder now includes the test and time.");
      return renderStaffTasks();
    }
    if (closeConsultation) {
      const medicine = String(data.get("medicine") || "").trim();
      const medications = medicine ? [{ name: medicine, dose: data.get("dose"), frequency: data.get("frequency"), instructions: data.get("instructions") }] : [];
      await api("/api/consultations/close", { method: "POST", body: JSON.stringify({ patientId: currentPatientId, assessment: data.get("assessment"), advice: data.get("advice"), medications }) });
      closeDrawer();
      showNotice("Consultation closed. Result, advice and prescription are now visible to the patient.");
      return renderCareNote();
    }
    if (labTaskId) {
      const results = { outcome: data.get("outcome") };
      await api(`/api/tasks/${labTaskId}`, { method: "PATCH", body: JSON.stringify({ status: "result_ready", results }) });
      closeDrawer();
      showNotice("Synthetic results published. The task now awaits clinician interpretation.");
      return renderStaffTasks();
    }
    if (replacementId) {
      await api(`/api/highlights/${replacementId}/reject-and-replace`, { method: "POST", body: JSON.stringify({ reason: data.get("reason"), diagnosis: data.get("diagnosis") }) });
      closeDrawer();
      showNotice("Old suggestion rejected. The clinician assessment now takes precedence; the original remains in history.");
      currentPage = "care";
      return renderCareNote();
    }
    if (editorEntryId) {
      await api(`/api/entries/${editorEntryId}/sections/plan`, { method: "PATCH", body: JSON.stringify({ content: data.get("content"), baseVersion: Number(event.target.dataset.baseVersion) }) });
      closeDrawer();
      return renderCareNote();
    }
    if (commentEntryId) {
      await api(`/api/entries/${commentEntryId}/comments`, { method: "POST", body: JSON.stringify({ body: data.get("body") }) });
      await renderCareNote();
      return openEntryDiscussion(commentEntryId);
    }
    if (consultationFeedback) {
      await api("/api/consultations/feedback", { method: "POST", body: JSON.stringify({ patientId: currentPatientId, rating: Number(data.get("rating")), comment: data.get("comment") }) });
      event.target.reset();
      document.querySelector("#feedbackBackdrop").classList.add("hidden");
      showNotice("Thank you. Your feedback was submitted.");
      return renderPatientPortal();
    }
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    event.target.dataset.submitting = "false";
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = submitLabel;
    }
  }
});

document.querySelector("#resetButton").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/test/reset", { method: "POST" });
    if (!response.ok) throw new Error("Reset is available only in demo mode.");
    currentPatientId = account.patientId || null;
    currentPage = role() === "patient" ? "patient" : role() === "admin" ? "audit" : "patients";
    closeDrawer();
    await loadView();
  } catch (error) { showNotice(error.message, "error"); }
});

document.querySelector("#closeDrawer").addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

const loginProfiles = {
  clinician: { eyebrow: "CLINICIAN ACCESS", title: "Welcome back, Dr Lee", username: "dr.lee", credentials: "dr.lee / clinician123" },
  staff: { eyebrow: "STAFF ACCESS", title: "Sign in as an individual staff member", username: "maya", credentials: "maya / staff123 · noah / staff456" },
  admin: { eyebrow: "ADMIN ACCESS", title: "Clinic operations access", username: "clinic.ops", credentials: "clinic.ops / admin123" }
};

document.querySelectorAll("[data-login-role]").forEach((button) => button.addEventListener("click", () => {
  const selectedRole = button.dataset.loginRole;
  document.querySelectorAll("[data-login-role]").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelector("#teamLoginPanel").classList.toggle("hidden", selectedRole === "patient");
  document.querySelector("#patientRegistrationPanel").classList.toggle("hidden", selectedRole !== "patient");
  document.querySelector("#loginError").classList.add("hidden");
  if (selectedRole !== "patient") {
    const profile = loginProfiles[selectedRole];
    const form = document.querySelector("#teamLoginForm");
    form.elements.role.value = selectedRole;
    form.elements.username.value = profile.username;
    form.querySelector("button").textContent = `Sign in as ${selectedRole}`;
    document.querySelector("#teamLoginEyebrow").textContent = profile.eyebrow;
    document.querySelector("#teamLoginTitle").textContent = profile.title;
    document.querySelector("#demoCredentials").textContent = profile.credentials;
  }
}));

function showLoginError(message) {
  const error = document.querySelector("#loginError");
  error.textContent = message;
  error.classList.remove("hidden");
}

document.querySelector("#teamLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ role: data.get("role"), username: data.get("username"), password: data.get("password") }) });
    event.target.elements.password.value = "";
    enterApp(result.account);
    await loadView();
  } catch (error) { showLoginError(error.message); }
});

document.querySelector("#patientRegistrationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    const result = await api("/api/auth/register-patient", { method: "POST", body: JSON.stringify({
      title: data.get("title"), givenName: data.get("givenName"), familyName: data.get("familyName"), age: Number(data.get("age")),
      pronouns: data.get("pronouns"), phone: data.get("phone"), syntheticConfirmed: data.get("syntheticConfirmed") === "on"
    }) });
    enterApp(result.account);
    await loadView();
  } catch (error) { showLoginError(error.message); }
});

document.querySelector("#returningPatientForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    const result = await api("/api/auth/register-patient", { method: "POST", body: JSON.stringify({
      patientId: data.get("patientId"), age: Number(data.get("age"))
    }) });
    enterApp(result.account);
    await loadView();
  } catch (error) { showLoginError(error.message); }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
  account = null;
  currentPatientId = null;
  showLogin();
});

let refreshing = false;
setInterval(async () => {
  if (!account || refreshing || drawer.classList.contains("open")) return;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
  refreshing = true;
  try { await loadView(); } catch (error) { if (account) console.warn(error); }
  finally { refreshing = false; }
}, 3000);

async function bootstrap() {
  try {
    const result = await api("/api/auth/session");
    if (!result.account) return showLogin();
    enterApp(result.account);
    installVoiceInputs();
    await loadView();
  } catch (error) { showLoginError(error.message); }
}

installVoiceInputs();
bootstrap();
