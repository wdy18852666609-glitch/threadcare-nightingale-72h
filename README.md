# ThreadCare demo

ThreadCare is a synthetic-data longitudinal care-note prototype for the Nightingale 72-hour build. It combines patient, clinician, staff/nurse and AI-scribed interactions in one role-scoped timeline, with glanceable highlights, provenance, comments, tasks, revision history and adaptive importance scoring.

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

The 24 automated tests use a local fake Responses-compatible endpoint, so they do not spend tokens or require a real API key. They cover RBAC, ownership, revisions and revert, provenance, concurrent edits, message recognition, three AI-scribe types, scheduled patient reminders and positive/negative self-learning feedback.

## Warm-path P95 benchmark

Run:

```text
npm run benchmark:p95
```

The benchmark performs 20 warm-up iterations followed by 200 measured iterations. Each iteration sequentially loads the patient care-note data and visible conversations, matching the two API requests used by the consult glance view.

Recorded on 26 August 2026 against the local synthetic in-memory server:

- Median: **31.05 ms**
- P95: **32.11 ms**
- P99: **32.52 ms**
- Requirement: **P95 <= 300 ms** - passed

This is a localhost prototype approximation, not a claim about production network latency. The script prints a timestamped JSON result so the measurement can be rerun and cited in the technical brief.
