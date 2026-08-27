# ThreadCare demo

ThreadCare is a synthetic-data longitudinal care-note prototype for the Nightingale 72-hour build. It combines patient, clinician, staff/nurse and AI-scribed interactions in one role-scoped timeline, with glanceable highlights, provenance, comments, tasks, revision history and adaptive importance scoring.

## Submission deliverables

- Working application and automated tests: this repository
- Technical brief: [`deliverables/ThreadCare_Technical_Brief_Wang_Yuyang.docx`](deliverables/ThreadCare_Technical_Brief_Wang_Yuyang.docx)
- External libraries, models and tool disclosure: [`ATTRIBUTION.txt`](ATTRIBUTION.txt)
- Demo video: recorded separately for submission

## Product freeze

The application feature set was frozen on 27 August 2026 for deliverable production. The frozen baseline includes the two-patient final demo seed, multi-role workflows, AI summarisation, provenance, revision control, RBAC, voice-to-text, adaptive importance learning and non-destructive data decay. After this point, application changes should be limited to reproducible demo-blocking defects, security problems or corrections required by the challenge brief.

## Role login and multi-device demo

The prototype now uses server-verified sessions rather than the old role switcher. Default local demo passwords are:

- Clinician: `dr.lee` / `clinician123`
- Staff: `maya` / `staff123`, or `noah` / `staff456`
- Admin: `clinic.ops` / `admin123`
- Patient: completes the synthetic registration form. Entering Mr / Chen / 68 continues the seeded Mr Chen record; other returning patients can supply their Patient ID.

Set `CLINICIAN_PASSWORD`, `STAFF_PASSWORD`, `STAFF_NOAH_PASSWORD`, and `ADMIN_PASSWORD` in `.env.local` before sharing. `npm start` enables durable local demo state in `data/demo-state.json`; session cookies remain browser-specific and expire after 12 hours. Multiple staff sessions share the clinic queue while preserving the individual actor on messages, notes, tasks and audit events.

For several computers on the same Wi-Fi, keep this computer and the server running, find this computer's IPv4 address, then open `http://YOUR-IP:3000` on each device. Windows Firewall may ask you to allow private-network access. This is a synthetic-data prototype using HTTP; do not expose it to the public internet or use real patient information.

### Final demo starting state

The committed seed is intentionally demo-ready rather than empty or filled with completed test runs:

- **Mr Chen (P-1001)** has a confirmed penicillin allergy, one concise prior clinician outcome and one older resolved AI entry collapsed into Compressed History. He has no current highlight, task, result, prescription or learned weight, so the main demo can begin with a fresh patient pre-consult.
- **Ms Taylor (P-1002)** is a clean new synthetic patient with no clinical history. She demonstrates empty states and that the workflow is not hard-coded to Mr Chen.

In demo mode, Admin can use **Restore demo** to return to this exact state after testing or a recording attempt. The action clears current synthetic activity and requires an explicit confirmation in the UI.

## Run locally

1. Copy `.env.example` to `.env.local`.
2. Add a Google Agent Platform / Vertex Express API key as `GOOGLE_API_KEY` (preferred), or configure the optional OpenAI fallback.
3. Start the demo with `npm start`.
4. Open `http://localhost:3000`.

The in-app setup page can also validate and persist a Google key into the ignored `.env.local` file. The browser never receives the key.

## AI and provenance

The configured external LLM creates structured suggestions and conversation summaries for three distinct interaction types:

- `ai_patient_session_summary`
- `ai_doctor_consult_summary`
- `ai_nurse_consult_summary`

AI entries remain distinct from clinician and staff manual notes. Each summary keeps message-level source pointers. Highlights expose a risk reason and exact source. Pinning confirms importance, not clinical truth; pinning raises future similar priority while rejection lowers it.

### Adaptive importance learning

The importance model is clinic-scoped and learns reusable signals from structured AI extraction rather than memorising one patient. Signals include symptom, patient hypothesis, self-treatment/action, urgency, recurrence, persistence and suggestion category. A clinician pin or rejection supplies a strong positive or negative signal; the first care-team comment on a suggestion supplies a smaller positive signal.

Top Card priority is explainable as: AI base score + explicit-risk bonus + recency bonus + unresolved-action bonus + team-learned weight. Clicking the score shows that breakdown and the matching learned signals. Learning changes ranking only: it cannot confirm a diagnosis or rewrite provenance. The automated bonus test demonstrates that pinning a cough-related suggestion for one synthetic patient increases the priority of a similar suggestion for another patient in the same clinic.

### Non-destructive data decay

The prototype applies a computed hot/warm/cold storage policy to timeline entries:

- Allergies, confirmed diagnoses, needs-review entries, unresolved tasks and unresolved comment threads stay hot regardless of age.
- AI/system context becomes warm after 30 days and cold after 180 days when no protection rule applies.
- Manual clinical/staff context becomes warm after 180 days and cold after 730 days when no protection rule applies.
- Cold entries are compressed into an archive card in the default Timeline view. They are not deleted: exact entries, source pointers, versions and audit metadata remain retrievable.

For this prototype the tiers are logical views over local JSON storage. In production, the same policy metadata would route encrypted records to hot database tables, warm object storage and cold archival storage while preserving stable provenance identifiers.

Consultations are repeatable and independently identified. Closing one consultation preserves its entries, sources, outcome and prescriptions in the patient-level longitudinal timeline. A later patient pre-consult or clinician action starts a new consultation with fresh conversation threads and AI summaries, including when both consultations occur on the same day.

## Voice input

Patient pre-consult, care-team chat and clinical/staff drawer text areas include a 30-second Voice button. The browser records mono WAV audio, Gemini returns a speech transcript, and the user must review the text before sending it. Raw audio is not retained. When the text is submitted, the existing redaction pipeline removes configured names, phone numbers and ID patterns before downstream AI summarisation. Live microphone capture requires HTTPS or `http://localhost:3000`; browsers block microphone permission on the plain-HTTP LAN address.

## Privacy and RBAC

Before any patient text is sent to the LLM, the server redacts configured names, phone numbers and supported ID patterns in `src/redaction.js`. Real keys remain in `.env.local`, which is excluded from Git.

Permissions are enforced in server middleware and store operations, not only in the UI:

- Patients cannot read internal comments, highlights or raw AI-scribed notes.
- Staff and clinicians are clinic-scoped.
- Staff notes can only be edited or reverted by the staff role.
- Clinician notes can only be edited or reverted by the clinician role.
- Only clinicians can pin or reject AI highlight suggestions.
- Audit records contain action metadata rather than note content.

This localhost prototype uses synthetic in-memory data. A production deployment would terminate TLS at the hosting layer and use encrypted managed storage; those deployment controls are outside this demo runtime.

## Tests

Run:

```text
npm test
```

The 39 automated tests use a local fake Responses-compatible endpoint, so they do not spend tokens or require a real API key. They cover RBAC, ownership, revisions and revert, provenance, concurrent edits, message recognition, three AI-scribe types, scheduled patient reminders, multi-account isolation, voice-transcription permissions, cross-patient importance learning, explainable feedback signals, non-destructive data decay and the recoverable final demo seed.

## Warm-path P95 benchmark

Run:

```text
npm run benchmark:p95
```

The benchmark performs 20 warm-up iterations followed by 200 measured iterations. Each iteration sequentially loads the patient care-note data and visible conversations, matching the two API requests used by the consult glance view.

Recorded on 26 August 2026 against the local synthetic in-memory server:

- Median: **31.51 ms**
- P95: **32.20 ms**
- P99: **32.44 ms**
- Requirement: **P95 <= 300 ms** - passed

This is a localhost prototype approximation, not a claim about production network latency. The script prints a timestamped JSON result so the measurement can be rerun and cited in the technical brief.
