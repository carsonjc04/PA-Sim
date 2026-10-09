# ClinicSim

ClinicSim is a deterministic educational clinical-encounter simulator for physician assistant students. Students work through five fictional primary-care encounters from the PA-student perspective, then explicitly submit for rubric-based grading and debrief.

This is an educational prototype, not clinical decision support. All patients and findings are fictional and require qualified clinician review before formal educational use. Do not enter real patient information.

## Run locally

```bash
npm install
cp .env.example .env   # sets DATABASE_URL and AUTH_PROVIDER=dev for local use
npm run db:up          # Postgres 17 in Docker on 127.0.0.1:5442 (dev + test databases)
npm run dev            # frontend on :5173, backend on :8787; migrations run at startup
```

`npm run dev:web` and `npm run dev:server` run the two halves separately.

- Checks: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
  (which also scans the bundle for answer-key leaks).
- `npm test` needs the Docker database. Each test file migrates its own
  isolated schema.
- `npm run db:migrate` applies migrations without starting the server.
- `npm run db:down` stops the database; data persists in a Docker volume.

Requires Node 22 or newer and Docker.

Practice history is stored by the server:

- Choose a **development identity** (any short name) in the header. It is not
  a password and is not verified; anyone can type any name.
- With `AUTH_PROVIDER=none` the app shows "Sign-in not available" and saves
  nothing.

The app runs without an `OPENAI_API_KEY`. Guided mode needs no key and no
microphone, but does need the backend. AI voice mode is disabled with a setup
hint until a key is configured. Keep the key in `.env` (gitignored) and never prefix it with
`VITE_`, which would ship it to the browser.

## Deploying the backend (Render)

Not yet verified against the live Render service; the deployed service needs
these changes before this version can run there.

- **Database:** create a Render Postgres instance. Set `DATABASE_URL` to its
  internal connection string and `DATABASE_SSL=true` if it requires TLS.
- **Start command:** `npm start`. The server applies pending migrations before
  listening.
  - `tsx` is currently a devDependency. Either move it to `dependencies` or
    make sure Render installs devDependencies.
- **Environment:**
  - Set `NODE_ENV=production`.
  - Set `CLIENT_ORIGIN` to the full Vercel URL, including `https://`.
  - **Auth:** with no sign-in provider yet, `AUTH_PROVIDER=none` keeps
    practice history disabled. `AUTH_PROVIDER=dev` together with
    `ALLOW_DEV_AUTH_IN_PRODUCTION=true` enables impersonable identities for a
    private demo only; the UI shows a warning banner.

## AI voice mode

The student speaks to an AI patient over WebRTC. The browser holds a microphone,
a speaker and a transcript; every secret stays on the server.

### Getting a key

1. Sign in at `platform.openai.com` and create a project.
2. Create an API key in that project.
3. Add billing credit to the project.

**API billing is separate from a ChatGPT subscription.** A ChatGPT Plus, Pro or
Team plan grants no API credit, and API usage is invoiced on its own. Set a
project spend limit and a usage alert before your first session.

Put the key in `.env`:

```dotenv
OPENAI_API_KEY=sk-...            # server only, never VITE_
OPENAI_LIVE_MODEL=gpt-live-1
OPENAI_DELEGATE_MODEL=gpt-5.6-terra
CLIENT_ORIGIN=http://localhost:5173
```

Restart the backend after editing `.env`. `GET /api/ai/status` reports whether
the server sees a key; it never returns the key itself.

### What costs money

| Action                                        | Billed                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| Guided mode, dashboard, results, tests, build | No                                                   |
| `npm test`                                    | No — the SDK is mocked and the smoke test is skipped |
| Clicking **Connect voice**                    | Yes, per second, until the session closes            |
| Muting                                        | **Yes** — mute only disables your microphone track   |
| Delegated reasoning and tool calls            | Yes, billed separately from the voice minute         |
| `npm run test:live`                           | Yes, a small authentication check                    |

`gpt-live-1` is billed per second of session duration. Close the session when
you are done; leaving the tab open keeps it open. The server rate-limits
session creation. `MAX_LIVE_SESSION_MINUTES` is reported to the browser but is
not yet enforced, so nothing closes a forgotten session automatically.

### Testing your microphone

WebRTC requires a secure context: `http://localhost:5173` counts, a LAN IP does
not. On the first **Connect voice** the browser prompts for microphone access —
choose Allow. If you blocked it earlier, clear the site permission and retry.
Denied or missing microphones surface a recoverable error with a retry button,
and guided mode stays available underneath.

### Falling back to guided mode

Guided mode is always present on the same encounter screen. If voice mode is
unconfigured, the microphone is denied, or a session fails, the guided flow
below the panel still completes the encounter and grades it identically.

## Architecture

- `src/data/scenarios.ts` contains the five handcrafted scenario definitions.
  Server-only; a lint rule blocks browser imports.
- `src/domain/types.ts` contains canonical domain types.
- `src/domain/schema.ts` validates scenarios with Zod.
- `src/domain/grading.ts` is pure, deterministic grading logic plus
  `GRADING_VERSION`. Only the server calls it.
- `src/api/contracts.ts` holds the request schemas and response types shared
  by server and browser. `src/api/client.ts` is the browser's only route to
  data.
- `src/App.tsx` owns the route-level screens. It holds no scenario data and
  does no grading.

Routes: `/` (home), `/dashboard`, `/cases`, `/encounter/:scenarioId`, and `/results/:attemptId`.

### Backend

`server/` is an Express app holding the answer key out of the browser. It
imports the same pure grading engine from `src/domain/grading.ts`, so there is
one scoring implementation rather than two that can drift.

- `server/config/env.ts` validates the environment with Zod and is the sole
  accessor for the API key.
- `server/db/` holds the Postgres pool, the checksummed migration runner and
  the SQL migrations.
- `server/auth/context.ts` defines the `AuthContext` and `AuthProvider`
  interfaces, plus the development-only `X-Dev-User` provider.
- `server/attempts/`:
  - `repository.ts` holds the only SQL.
  - `service.ts` handles transactions, idempotency and grading.
  - `projection.ts` builds browser payloads by allowlist.
- `server/tools/` accepts stable IDs only and enforces phase locks.
- `server/api/attempts.ts` provides start/resume, events, submit, detail and
  history. `server/api/routes.ts` serves the scenario catalog, auth status and
  AI status.
- `server/api/live.ts` creates GPT-Live sessions and relays delegated tool calls.
- `server/prompts/patient.ts` builds the patient persona from patient-knowable facts only.

### Voice transport

`POST /api/live/session` takes `{ sdp, attemptId }` for an attempt the caller owns, calls `openai.live.create`
with Responses delegation, and returns only `{ sessionId, sdp }`. The browser
never sees the key, the answer key, or the prompts.

- `src/voice/liveClient.ts` owns the `RTCPeerConnection`, the `oai-events` data channel, and cleanup.
- `src/voice/transcript.ts` reassembles delta fragments per speaker, so full-duplex overlap stays attributed.
- `src/voice/useVoiceEncounter.ts` binds that lifecycle to React and closes the session on unmount.
- `src/features/encounter/VoicePanel.tsx` renders connect, permission, live, mute, end, error and retry states.

See `docs/architecture.md` for hidden-state rules, confirmation requirements,
known limitations, and what the voice layer still needs.

## Scenario data and adding a sixth case

Add another `ScenarioDefinition` to `src/data/scenarios.ts` (or split the data into one module per case), using stable IDs for every phase, action, diagnosis, plan item, omission, and critical rule. Include a non-spoiler summary, clinical references, `reviewStatus: "requires-clinician-review"`, and all five phases. Run `npm test` and `npm run build`; no encounter or results component should need to change. Editing an existing scenario creates a new content version on the next attempt; existing attempts keep grading against the version they started with.

Rules are data-driven: action visibility can use `requires` and `excludes`, while grading refers only to stable IDs. Keep teaching text original and concise; references are metadata, not copied source material.

## Scoring

The weighted categories are History 20%, Physical examination 15%, Diagnostics and reasoning 15%, Diagnostic accuracy 20%, Treatment and follow-up 20%, and Communication 10%. Category scores are clamped from 0 to 100, the weighted total is rounded, and 70% is the normal pass threshold. A critical safety rule forces failure and caps the displayed score at 59%; both `rawScore` and `finalScore` remain on the attempt record.

Results are graded once by the server and stored with the grading version and the content version they were graded against. The dashboard shows only the current identity's real attempts; there is no seeded demo history. Older browser-only results (`clinicsim-attempts-v1`) are not imported; see `docs/architecture.md` for why.

## Portraits

Portraits are configured in each scenario's `patient.portrait` and `clinician` objects. A future `src` can be a local or stable royalty-free asset. The portrait component falls back to configured initials with descriptive alt text when an image is missing or fails.

## Clinical-content limitations

Reference metadata points to CDC outpatient antibiotic guidance, ADA Standards of Care in Diabetes—2026, GINA asthma guidance, and ACC/AHA/ACEP/NAEMSP/SCAI acute coronary syndrome guidance. The prototype has not been clinically validated, is not a curriculum, and must be reviewed by qualified clinicians before formal use.

## Tests

`src/domain/grading.test.ts` covers all five schema validations, spoiler-safe summaries, partial weighted credit, idempotence, critical-error capping, and data-driven visibility evaluation.

`server/db/migrate.test.ts` covers fresh, repeat, tampered, failing and concurrent migrations. `server/api/attempts.test.ts` covers cross-user access on every route, malformed payloads, idempotent events and submit (including concurrent retries), refresh/resume, a new device session, pagination, content-version pinning, and hidden-content scans before and after submit.

`server/` and `src/voice/` also cover hidden-answer leakage, tool
validation and idempotence, the live session endpoint with the OpenAI SDK
mocked, missing-key behaviour, provider-error sanitization, rate limiting,
transcript aggregation across overlapping speakers, and the WebRTC lifecycle
with a mocked `RTCPeerConnection` including microphone denial and cleanup.

`npm test` never contacts OpenAI. `npm run test:live` is opt-in and billable; it
verifies the credential and the SDK surface but cannot open a session, because
`live.create` needs a browser-generated SDP offer.
