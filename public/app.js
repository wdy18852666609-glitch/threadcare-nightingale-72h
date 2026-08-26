const roleSelect = document.querySelector("#roleSelect");
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

const identities = {
  clinician: "clinician-lee",
  staff: "staff-maya",
  patient: "patient-chen",
  admin: "admin-ops"
};

let view = null;
let currentPage = "patient";
let startedAt = performance.now();

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    "x-role": roleSelect.value,
    "x-user-id": identities[roleSelect.value],
    "x-clinic-id": "clinic-sg-01",
    ...extra
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: headers(options.headers) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
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
    const mine = message.authorRole === roleSelect.value;
    const ai = message.authorRole === "system";
    return `<div class="message-bubble ${mine ? "mine" : ""} ${ai ? "ai" : ""}"><span>${escapeHtml(roleLabel(message.authorRole))} · ${formatDate(message.createdAt)}</span><p>${escapeHtml(message.body)}</p></div>`;
  }).join("");
  container.scrollTop = container.scrollHeight;
}

function renderPatientTreatment() {
  const panel = document.querySelector("#patientTreatment");
  const outcome = view.entries.find((entry) => entry.type === "consultation_outcome");
  if (!outcome) {
    panel.innerHTML = `<div class="empty-state">No clinician-confirmed consultation result or prescription yet.</div>`;
    return;
  }
  panel.innerHTML = `<div class="treatment-card"><span class="eyebrow">CLINICIAN-CONFIRMED PLAN</span><h2>${escapeHtml(outcome.sections.summary)}</h2><p>${escapeHtml(outcome.sections.plan)}</p><div class="medicine-list">${view.prescriptions.length ? view.prescriptions.map((medicine) => `<div class="medicine-card"><strong>${escapeHtml(medicine.name)}</strong><span>${escapeHtml(medicine.dose)} · ${escapeHtml(medicine.frequency)}</span><span>${escapeHtml(medicine.instructions)}</span></div>`).join("") : `<span>No medication prescribed.</span>`}</div></div>`;
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
    "Patients / P-1001"
  );
}

function renderTopCards() {
  const highlight = view.highlights[0];
  const linkedTask = highlight ? view.tasks.find((item) => item.sourceHighlightId === highlight.id) : null;
  const activeTask = view.tasks.find((item) => !["reviewed", "cancelled"].includes(item.status));
  const confirmedConclusion = view.entries.find((entry) => entry.type === "confirmed_diagnosis");

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
        ${roleSelect.value === "clinician" && highlight.status !== "accepted" ? `<button class="button small" data-pin-highlight="${highlight.id}">Pin as important</button>` : ""}
        ${highlight.status === "accepted" ? `<span class="status-pill accepted">Pinned · not a diagnosis</span>` : ""}
        ${roleSelect.value === "clinician" && !linkedTask ? `<button class="button small" data-create-task="${highlight.id}">Create staff task</button>` : ""}
        ${roleSelect.value === "clinician" ? `<button class="button small danger" data-reject-replace="${highlight.id}">Reject & replace</button>` : ""}
        ${linkedTask && linkedTask.status !== "result_ready" ? `<span class="status-pill suggested">Testing ${linkedTask.status.replace("_", " ")}</span>` : ""}
        <span class="importance-score ${highlight.status === "accepted" ? "high" : "medium"}" title="${escapeHtml(highlight.riskReason)}">${highlight.score}</span>
      </div>
    </article>` : `
    <article class="attention-card review"><div class="card-label"><span class="glance-icon">?</span>Needs review</div><h3>No new patient concern awaiting review</h3><div class="glance-controls"><span class="importance-score zero">0</span></div></article>`;

  const taskRow = activeTask ? `
    <article class="attention-card action">
      <div class="card-label"><span class="glance-icon">✓</span>${activeTask.status === "result_ready" ? "Results ready" : "Open action"}</div>
      <h3>${activeTask.status === "result_ready" ? `Synthetic result: ${escapeHtml(taskResultText(activeTask))}` : escapeHtml(activeTask.title)}</h3>
      <div class="glance-controls">
        ${activeTask.resultEntryId ? `<button class="source-link" data-event-entry="${activeTask.resultEntryId}">View result</button>` : ""}
        <span class="status-pill ${activeTask.status}">${activeTask.status.replace("_", " ")}</span>
        <span class="importance-score ${activeTask.status === "result_ready" ? "high" : "medium"}">${activeTask.status === "result_ready" ? 90 : activeTask.status === "to_do" ? 82 : 74}</span>
      </div>
    </article>` : `
    <article class="attention-card action"><div class="card-label"><span class="glance-icon">✓</span>Open action</div><h3>No active clinical task</h3><div class="glance-controls"><span class="status-pill">None</span><span class="importance-score zero">0</span></div></article>`;

  const allergy = view.patient.allergies?.[0];
  const allergyRow = `
    <article class="attention-card risk">
      <div class="card-label"><span class="glance-icon">!</span>Critical allergy</div>
      <h3>${escapeHtml(allergy?.substance || "Penicillin")} · ${escapeHtml(allergy?.reaction || "Severe allergic reaction")}</h3>
      <div class="glance-controls"><button class="source-link" data-event-entry="${allergy?.sourceEntryId || "E-ALLERGY-01"}">Source</button><span class="status-pill accepted">Confirmed</span><span class="importance-score high">98</span></div>
    </article>`;

  topCards.innerHTML = `${reviewRow}${taskRow}${allergyRow}`;
}

function renderTimeline() {
  // Patient submissions remain stored as the source of truth, but the AI-scribed
  // timeline card already links back to that exact source. Showing both cards
  // would represent one encounter twice in the clinical timeline.
  const timelineEntries = view.entries.filter((entry) => entry.type !== "patient_message");
  if (!timelineEntries.length) {
    timeline.innerHTML = `<div class="empty-state">No entries are visible to this role.</div>`;
    return;
  }
  timeline.innerHTML = [...timelineEntries].reverse().map((entry) => {
    const comments = view.comments.filter((comment) => comment.entryId === entry.id);
    const date = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", year: "2-digit" }).format(new Date(entry.occurredAt));
    return `
      <article class="timeline-entry ${entry.status === "superseded" ? "superseded" : ""}" id="entry-${entry.id}">
        <div class="timeline-node-row"><span class="timeline-date">${date}</span><span class="timeline-dot"></span></div>
        <div class="timeline-connector"></div>
        <div class="entry-card" data-event-entry="${entry.id}">
          <div class="entry-meta"><span><strong>${roleLabel(entry.authorRole)}</strong></span><span>${escapeHtml(entry.status.replaceAll("_", " "))}</span></div>
          <h3>${escapeHtml(entry.sections.summary)}</h3>
          <div class="entry-actions"><span class="entry-hint">Open details & comments →</span>${comments.length ? `<span class="status-pill">${comments.length} comment${comments.length > 1 ? "s" : ""}</span>` : ""}</div>
        </div>
      </article>`;
  }).join("");
}

async function renderCareNote() {
  hideAllViews();
  careView.classList.remove("hidden");
  startedAt = performance.now();
  view = await api("/api/patients/P-1001");
  renderPatientHeader();
  renderTopCards();
  renderTimeline();
  const conversations = await api("/api/conversations?patientId=P-1001");
  renderConversation("clinicianPatientChat", conversations.find((item) => item.id === "C-PATIENT-CLINICIAN"));
  renderConversation("clinicianTeamChat", conversations.find((item) => item.id === "C-CLINICAL-TEAM"));
  document.querySelector("#clinicianPatientPanel").classList.toggle("hidden", roleSelect.value !== "clinician");
  document.querySelector("#closeConsultationButton").classList.toggle("hidden", roleSelect.value !== "clinician");
  const addNoteButton = document.querySelector("#addNoteButton");
  addNoteButton.classList.toggle("hidden", !["staff", "clinician"].includes(roleSelect.value));
  addNoteButton.textContent = roleSelect.value === "staff" ? "Add staff note" : "Add clinician note";
  document.querySelector("#loadTime").textContent = `${Math.max(1, Math.round(performance.now() - startedAt))}ms observed`;
}

async function renderPatientPortal() {
  hideAllViews();
  patientPortal.classList.remove("hidden");
  view = await api("/api/patients/P-1001");
  const conversations = await api("/api/conversations?patientId=P-1001");
  setHeader("My pre-consult session", "Share symptoms and questions before your visit", "Patient portal / Mr Chen");
  renderConversation("patientAiChat", conversations.find((item) => item.id === "C-PATIENT-AI"));
  renderConversation("patientClinicianChat", conversations.find((item) => item.id === "C-PATIENT-CLINICIAN"));
  renderConversation("patientStaffChat", conversations.find((item) => item.id === "C-PATIENT-STAFF"));
  renderPatientReminders();
  renderPatientTreatment();
}

async function renderPatientList() {
  hideAllViews();
  patientListView.classList.remove("hidden");
  const patients = await api("/api/patients");
  view = await api("/api/patients/P-1001");
  setHeader("Patient queue", "Select a patient to open the shared longitudinal care note", "Clinician workspace");
  document.querySelector("#patientList").innerHTML = patients.map((patient) => `
    <article class="patient-row">
      <div><h3>${escapeHtml(patient.displayName)}</h3><p>${patient.age} years · Last visit ${patient.lastVisit}</p>${view.highlights.length ? `<span class="patient-alert">● ${view.highlights.length} new item needs review</span>` : `<span class="patient-alert" style="color:var(--muted)">No new patient concern</span>`}</div>
      <button class="button" data-open-patient="${patient.id}">Open care note</button>
    </article>`).join("");
}

async function renderStaffTasks() {
  hideAllViews();
  staffTaskView.classList.remove("hidden");
  view = await api("/api/patients/P-1001");
  const tasks = await api("/api/tasks");
  const current = tasks.find((item) => !["reviewed", "cancelled"].includes(item.status));
  setHeader("Staff task board", "Clinic-scoped operational follow-up", "Staff workspace");
  document.querySelector("#staffGlance").innerHTML = current ? `<div class="staff-glance-card"><div><span class="eyebrow" style="color:#9ed4bf">TOP ACTION</span><h3>${escapeHtml(current.title)}</h3><p>Mr Chen · Ordered by ${escapeHtml(current.createdBy)}</p></div><span class="importance-score high">${current.status === "result_ready" ? 90 : 82}</span></div>` : `<div class="empty-state">No active task assigned.</div>`;
  document.querySelector("#staffTasks").innerHTML = tasks.length ? tasks.map((task) => `
    <article class="task-row"><div><span class="eyebrow">${escapeHtml(task.status.replace("_", " "))}</span><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.rationale)}</p>${task.scheduledAt ? `<p><strong>Scheduled:</strong> ${formatDate(task.scheduledAt)}</p>` : ""}${task.results ? `<div class="result-panel">Recorded result: ${escapeHtml(taskResultText(task))}</div>` : ""}</div><div class="card-actions">${task.status === "to_do" ? `<button class="button" data-schedule-task="${task.id}">Set test time</button>` : ""}${task.status === "scheduled" ? `<button class="button" data-complete-task="${task.id}">Complete & add results</button>` : ""}<span class="status-pill ${task.status}">${escapeHtml(task.status.replace("_", " "))}</span></div></article>`).join("") : `<div class="empty-state">Tasks created by clinicians will appear here.</div>`;
  const conversations = await api("/api/conversations?patientId=P-1001");
  renderConversation("staffTeamChat", conversations.find((item) => item.id === "C-CLINICAL-TEAM"));
  renderConversation("staffPatientChat", conversations.find((item) => item.id === "C-PATIENT-STAFF"));
}

async function renderAdmin() {
  hideAllViews();
  adminView.classList.remove("hidden");
  setHeader("Clinic audit", "Metadata-only activity log", "Admin workspace");
  const events = await api("/api/audit");
  adminView.innerHTML = `<div class="section-heading"><div><span class="eyebrow">METADATA ONLY</span><h2>Clinic audit log</h2></div></div>${events.length ? `<table class="audit-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th></tr></thead><tbody>${events.map((event) => `<tr><td>${formatDate(event.at)}</td><td>${escapeHtml(event.actorRole)} · ${escapeHtml(event.actorId)}</td><td>${escapeHtml(event.action)}</td><td>${escapeHtml(event.resourceType)} · ${escapeHtml(event.resourceId)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty-state">No actions yet. Audit logs store metadata, not note contents.</div>`}`;
}

async function loadView() {
  if (roleSelect.value === "patient") return renderPatientPortal();
  if (roleSelect.value === "staff") return renderStaffTasks();
  if (roleSelect.value === "admin") return renderAdmin();
  if (currentPage === "care") return renderCareNote();
  return renderPatientList();
}

function showDrawer(content, title = "Entry details") {
  document.querySelector("#drawerTitle").textContent = title;
  document.querySelector("#drawerContent").innerHTML = content;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.classList.remove("hidden");
}

function closeDrawer() {
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.classList.add("hidden");
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
    ? source.spans.map((item) => `<div class="message-bubble ${item.authorRole === "system" ? "ai" : ""}"><span>${escapeHtml(roleLabel(item.authorRole))} · ${item.occurredAt ? formatDate(item.occurredAt) : "Source message"}</span><p>${escapeHtml(item.messageBody || item.text)}</p></div>`).join("")
    : `<div class="transcript"><span class="timestamp">${span?.occurredAt ? formatDate(span.occurredAt) : span?.startSeconds !== undefined ? `${span.startSeconds}s–${span.endSeconds ?? "end"}` : "Source message"}</span><p>${span ? `<mark>${escapeHtml(span.text)}</mark>` : "No transcript span attached."}</p></div>`;
  showDrawer(`<div class="source-meta"><div><span>Interaction</span><strong>${escapeHtml(source.interactionType.replaceAll("_", " "))}</strong></div><div><span>Generated by</span><strong>${escapeHtml(source.authorRole)}</strong></div><div><span>Occurred</span><strong>${formatDate(source.occurredAt)}</strong></div><div><span>Generated</span><strong>${source.generatedAt ? formatDate(source.generatedAt) : "Manual entry"}</strong></div></div>${isConversationSource ? `<div class="message-list source-chat">${transcript}</div>` : transcript}<p class="patient-meta">The server verified role and clinic scope before returning this source.</p>`, isConversationSource ? "Full conversation source" : "Exact source");
}

function openEntryDiscussion(entryId) {
  const entry = view.entries.find((item) => item.id === entryId);
  if (!entry) return;
  const comments = view.comments.filter((comment) => comment.entryId === entryId);
  const sourceLabel = entry.spans.some((item) => item.messageId) ? "View full conversation source" : "View exact source";
  const canEditOwnNote = ["staff", "clinician"].includes(roleSelect.value) && entry.authorRole === roleSelect.value;
  showDrawer(`<div class="source-meta"><div><span>Author</span><strong>${roleLabel(entry.authorRole)}</strong></div><div><span>Status</span><strong>${escapeHtml(entry.status.replaceAll("_", " "))}</strong></div><div><span>Date</span><strong>${formatDate(entry.occurredAt)}</strong></div><div><span>Version</span><strong>v${entry.version}</strong></div></div><div class="transcript"><span class="eyebrow">SUMMARY</span><p>${escapeHtml(entry.sections.summary)}</p><span class="eyebrow">PLAN</span><p>${escapeHtml(entry.sections.plan)}</p></div><div class="entry-actions">${entry.spans.length ? `<button class="button small secondary" data-source="${entry.id}" data-span="${entry.spans[0].id}">${sourceLabel}</button>` : ""}${canEditOwnNote ? `<button class="button small secondary" data-edit-entry="${entry.id}">Edit plan</button><button class="button small secondary" data-history-entry="${entry.id}">Version history</button>` : ""}</div><div style="margin-top:18px"><span class="eyebrow">COMMENTS · ${comments.length}</span>${comments.length ? comments.map((comment) => `<div class="comment-box"><span><strong>${escapeHtml(comment.authorRole)}</strong> · ${escapeHtml(comment.body)} ${comment.resolved ? "· ✓ resolved" : ""}</span>${["staff", "clinician"].includes(roleSelect.value) ? `<button class="source-link" data-comment-toggle="${comment.id}" data-resolved="${!comment.resolved}">${comment.resolved ? "Reopen" : "Resolve"}</button>` : ""}</div>`).join("") : `<p class="patient-meta">No comments on this event.</p>`}${["staff", "clinician"].includes(roleSelect.value) ? `<form class="inline-form" data-comment-form="${entry.id}"><input name="body" placeholder="Comment with @clinician…" required><button class="button small">Add</button></form>` : ""}</div>`, "Event discussion");
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
  const noteRole = roleSelect.value;
  if (!["staff", "clinician"].includes(noteRole)) return;
  showDrawer(`<p class="patient-meta">This note will be owned by ${escapeHtml(roleLabel(noteRole))}. Other roles may read it but cannot edit or revert it.</p><form class="manual-note-form" data-manual-note-form><label>Note summary<textarea name="summary" placeholder="Enter the observed update…" required></textarea></label><label>Plan or follow-up<textarea name="plan" placeholder="Enter the next step…"></textarea></label><button class="button">Add ${escapeHtml(noteRole)} note to timeline</button></form>`, `Add ${roleLabel(noteRole)} note`);
}

function openCloseConsultationForm() {
  showDrawer(`<p class="patient-meta">Only the clinician can enter the final result, advice and any prescription. Nothing is pre-filled.</p><form class="consultation-form" data-close-consultation><label>Clinician assessment<textarea name="assessment" placeholder="Enter the consultation result…" required></textarea></label><label>Advice for the patient<textarea name="advice" placeholder="Enter the patient-facing advice…" required></textarea></label><span class="eyebrow">PRESCRIPTION · OPTIONAL</span><label>Medication<input name="medicine" placeholder="Leave blank if no medication is prescribed"></label><label>Dose<input name="dose" placeholder="Dose"></label><label>Frequency<input name="frequency" placeholder="Frequency"></label><label>Instructions<textarea name="instructions" placeholder="Medication instructions"></textarea></label><button class="button">Confirm result & end consultation</button></form>`, "End consultation");
}

function openReplacementForm(highlightId) {
  const task = view.tasks.find((item) => item.sourceHighlightId === highlightId && item.status === "result_ready");
  showDrawer(`<div class="result-panel">Recorded evidence: ${escapeHtml(taskResultText(task))}</div><p class="patient-meta">Reject the unconfirmed patient hypothesis, then enter the clinician-authored conclusion yourself. The original entry remains in history as superseded.</p><form class="replacement-form" data-replacement-form="${highlightId}"><label>Reason for rejection<textarea name="reason" placeholder="Why is the original hypothesis being rejected?" required></textarea></label><label>Replacement clinical conclusion<textarea name="diagnosis" placeholder="Enter the clinician's conclusion…" required></textarea></label><label>Clinical plan<textarea name="plan" placeholder="Enter the clinical plan…" required></textarea></label><label>Patient-facing summary<textarea name="patientSummary" placeholder="What should the patient see?" required></textarea></label><label>Patient-facing next step<textarea name="patientPlan" placeholder="What should the patient do next?" required></textarea></label><button class="button danger">Reject old hypothesis & update timeline</button></form>`, "Reject and replace");
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
  const addNoteButton = event.target.closest("#addNoteButton, [data-open-manual-note]");
  try {
    if (nav) {
      closeDrawer();
      currentPage = nav.dataset.nav;
      if (currentPage === "messages") {
        if (roleSelect.value === "patient") return renderPatientPortal();
        if (roleSelect.value === "staff") return renderStaffTasks();
        if (roleSelect.value === "clinician") return renderCareNote();
      }
      if (roleSelect.value === "clinician" && currentPage === "patients") return renderPatientList();
      if (roleSelect.value === "staff" && currentPage === "tasks") return renderStaffTasks();
      if (roleSelect.value === "admin" && currentPage === "audit") return renderAdmin();
      if (["clinician", "staff"].includes(roleSelect.value) && currentPage === "care") return renderCareNote();
      return loadView();
    }
    if (openPatient) { currentPage = "care"; return renderCareNote(); }
    if (sourceButton) return openSource(sourceButton.dataset.source, sourceButton.dataset.span);
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
      return roleSelect.value === "staff" ? renderStaffTasks() : renderCareNote();
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
  if (!patientSession && !labTaskId && !replacementId && !editorEntryId && !commentEntryId && !conversationId && !closeConsultation && !createTaskHighlightId && !scheduleTaskId && !manualNote) return;
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    if (patientSession) {
      const result = await api("/api/patient-sessions", { method: "POST", body: JSON.stringify({ patientId: "P-1001", message: data.get("message"), knownNames: ["Mr Chen"] }) });
      showNotice(result.acknowledgement);
      event.target.reset();
      return renderPatientPortal();
    }
    if (conversationId) {
      await api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ body: data.get("body"), knownNames: ["Mr Chen"] }) });
      if (conversationId === "C-CLINICAL-TEAM" && roleSelect.value === "clinician" && String(data.get("taskTitle") || "").trim()) {
        await api("/api/tasks", { method: "POST", body: JSON.stringify({ patientId: "P-1001", title: data.get("taskTitle"), rationale: `Published from clinical-team message: ${data.get("body")}`, resultType: "general_assessment", sourceConversationId: conversationId }) });
        showNotice("Message sent and task published to staff.");
      }
      event.target.reset();
      if (roleSelect.value === "patient") return renderPatientPortal();
      if (roleSelect.value === "staff") return renderStaffTasks();
      return renderCareNote();
    }
    if (manualNote) {
      await api("/api/entries", { method: "POST", body: JSON.stringify({ patientId: "P-1001", summary: data.get("summary"), plan: data.get("plan") }) });
      closeDrawer();
      showNotice(`${roleLabel(roleSelect.value)} note added. Only its author role can edit or revert it.`);
      currentPage = "care";
      return renderCareNote();
    }
    if (createTaskHighlightId) {
      await api("/api/tasks", { method: "POST", body: JSON.stringify({ patientId: "P-1001", title: data.get("title"), rationale: data.get("rationale"), resultType: "general_assessment", sourceHighlightId: createTaskHighlightId }) });
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
      await api("/api/consultations/close", { method: "POST", body: JSON.stringify({ patientId: "P-1001", assessment: data.get("assessment"), advice: data.get("advice"), medications }) });
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
      await api(`/api/highlights/${replacementId}/reject-and-replace`, { method: "POST", body: JSON.stringify({ reason: data.get("reason"), diagnosis: data.get("diagnosis"), plan: data.get("plan"), patientSummary: data.get("patientSummary"), patientPlan: data.get("patientPlan") }) });
      closeDrawer();
      showNotice("Old hypothesis rejected. Clinician conclusion and patient-facing update added; history preserved.");
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
  } catch (error) { showNotice(error.message, "error"); }
});

roleSelect.addEventListener("change", () => {
  closeDrawer();
  currentPage = { patient: "patient", clinician: "patients", staff: "tasks", admin: "audit" }[roleSelect.value];
  loadView().catch((error) => showNotice(error.message, "error"));
});

document.querySelector("#resetButton").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/test/reset", { method: "POST" });
    if (!response.ok) throw new Error("Reset is available only in demo mode.");
    roleSelect.value = "patient";
    currentPage = "patient";
    closeDrawer();
    await loadView();
  } catch (error) { showNotice(error.message, "error"); }
});

document.querySelector("#closeDrawer").addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

loadView().catch((error) => showNotice(error.message, "error"));
