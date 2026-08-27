# ThreadCare public deployment

## Live application

**URL:** [https://threadcare-wang-yuyang.wang-yuyang.workers.dev](https://threadcare-wang-yuyang.wang-yuyang.workers.dev)

The public site is hosted in Wang Yuyang's Cloudflare account and does not depend on the development computer remaining online.

## Deployed architecture

- **Compute and static delivery:** Cloudflare Workers and Workers static assets
- **Shared state:** Cloudflare D1 database `threadcare-demo` in the APAC region
- **AI:** Google Gemini `gemini-2.5-flash`; the API key is stored as a Cloudflare Worker secret
- **Transport:** HTTPS on the `workers.dev` domain
- **Client sessions:** server-verified role sessions stored with the shared synthetic clinic state; each browser receives its own HTTP-only cookie
- **Safety boundary:** synthetic names and health information only

The deployment persists one clinic-scoped JSON state snapshot in D1. This makes the complete demo workflow available across patient, clinician, staff and admin devices while preserving the existing relationships, versions, audit events and provenance pointers. It is a deliberate prototype storage design, not a claim of production-grade healthcare infrastructure.

## Public verification completed

The deployed URL was checked for:

1. HTTPS homepage response (`200 OK`)
2. External LLM configuration (`google-vertex-ai`, `gemini-2.5-flash`)
3. Clinician authentication as Dr Lee
4. Shared retrieval of the two clean demo patients: Mr Chen and Ms Taylor
5. Cloudflare Worker binding to the `threadcare-demo` D1 database

The existing automated suite remains the repeatable verification source for RBAC, provenance, revision ownership, concurrent edit behavior, repeat consultations, task/result idempotency, adaptive importance learning and non-destructive data decay.

## Local development remains supported

`npm start` runs the Node.js development server at `http://localhost:3000` and persists local state in the ignored `data/demo-state.json` file. This path is for development and offline rehearsal; it is not the public deployment. Local API keys and passwords belong in the ignored `.env.local` file.

## Production boundary

ThreadCare is a public challenge demo, not a production clinical system. It does not claim authorization for real patient data, regulatory compliance, production identity assurance, normalized transactional clinical storage, backup/recovery guarantees, or validated clinical decision support. Do not enter real patient information.
