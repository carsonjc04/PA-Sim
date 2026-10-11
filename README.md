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
  (which validates the content package in strict mode, then scans the bundle for answer-key leaks).
- Content: `npm run content:validate`, `content:lock`, `content:coverage`. Node 22 or newer (`.nvmrc`).
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

Verified locally with a production-only install (`npm ci --omit=dev`, then
`npm start`); not yet verified on the live Render service.

- **Database:** create a Render Postgres instance. Set `DATABASE_URL` to its
  internal connection string and `DATABASE_SSL=true` if it requires TLS.
- **Start command:** `npm start`. The server applies pending migrations before
  listening. `tsx` is a production dependency for this reason.
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

- `content/` holds the versioned content package: `manifest.json`, one JSON `ScenarioDefinition` plus fixtures per case, `taxonomy.json` (with `taxonomy-history.json`), `blueprints/` (official PANCE and EOR blueprint versions), `sprints/` and `lock.json`. `server/content/` validates and loads it.
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

Routes: `/` (home), `/dashboard`, `/cases` (accepts `?system=&task=&rotation=`), `/encounter/:scenarioId`, `/results/:attemptId`, `/review`, and the study modes `/study`, `/study/rotation/:rotationId`, `/study/pance`, `/study/mixed` and `/study/sprint` ([docs/exam-blueprints.md](docs/exam-blueprints.md)).

- `src/domain/study/` holds the pure blueprint, coverage and ranking logic; `server/study/` and `server/api/study.ts` serve it under `/api/study`.

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

Cases are JSON under `content/` with a versioned manifest. Follow [docs/case-authoring-guide.md](docs/case-authoring-guide.md) and start from `content/template/scenario.template.json`. Run `npm run content:validate`, then `npm run content:lock` and `npm run content:coverage` when the version is final; no encounter or results component should need to change. An invalid package cannot start the server or pass `npm run build`. Editing an existing scenario creates a new content version on the next attempt; existing attempts keep grading against the version they started with.

Rules are data-driven: action visibility can use `requires` and `excludes`, while grading refers only to stable IDs. Keep teaching text original and concise; references are metadata, not copied source material.

## Scoring

The weighted categories are History 20%, Physical examination 15%, Diagnostics and reasoning 15%, Diagnostic accuracy 20%, Treatment and follow-up 20%, and Communication 10%. Category scores are clamped from 0 to 100, the weighted total is rounded, and 70% is the normal pass threshold. A critical safety rule forces failure and caps the displayed score at 59%; both `rawScore` and `finalScore` remain on the attempt record.

Results are graded once by the server and stored with the grading version and the content version they were graded against. The dashboard shows only the current identity's real attempts; there is no seeded demo history. Older browser-only results (`clinicsim-attempts-v1`) are not imported; see `docs/architecture.md` for why.

## Portraits

Portraits are configured in each scenario's `patient.portrait` and `clinician` objects. A future `src` can be a local or stable royalty-free asset. The portrait component falls back to configured initials with descriptive alt text when an image is missing or fails.

## Clinical-content limitations

Reference metadata points to CDC outpatient antibiotic guidance, ADA Standards of Care in Diabetes—2026, GINA asthma guidance, and ACC/AHA/ACEP/NAEMSP/SCAI acute coronary syndrome guidance. The prototype has not been clinically validated, is not a curriculum, and must be reviewed by qualified clinicians before formal use.

## Tests

`server/content/grading.test.ts` and `server/content/validate.test.ts` cover all five schema validations, spoiler-safe summaries, partial weighted credit, idempotence, critical-error capping, and data-driven visibility evaluation.

`server/db/migrate.test.ts` covers fresh, repeat, tampered, failing and concurrent migrations. `server/api/attempts.test.ts` covers cross-user access on every route, malformed payloads, idempotent events and submit (including concurrent retries), refresh/resume, a new device session, pagination, content-version pinning, and hidden-content scans before and after submit.

`server/` and `src/voice/` also cover hidden-answer leakage, tool
validation and idempotence, the live session endpoint with the OpenAI SDK
mocked, missing-key behaviour, provider-error sanitization, rate limiting,
transcript aggregation across overlapping speakers, and the WebRTC lifecycle
with a mocked `RTCPeerConnection` including microphone denial and cleanup.

`npm test` never contacts OpenAI. `npm run test:live` is opt-in and billable; it
verifies the credential and the SDK surface but cannot open a session, because
`live.create` needs a browser-generated SDP offer.

`server/api/review.test.ts` covers the remediation loop: a missed objective becoming due, a review changing the schedule, duplicate review events, no duplicate cards per knowledge component, resume after refresh, leakage before submission, unmapped cases, backfill, algorithm upgrades, and an acceptance check that every graded miss of every fixture has a traceable remediation state. See [docs/remediation.md](docs/remediation.md).

`server/content/blueprints.test.ts`, `server/content/taxonomy-history.test.ts`, `server/content/sprints.test.ts`, `server/study/*.test.ts`, `server/api/study.test.ts` and `src/features/study/study.test.tsx` cover the exam blueprints and study modes: taxonomy completeness, weight totals for every blueprint matrix, retired and legacy versions, historical tag stability for stored snapshots, empty categories, the full-exam and alignment gates, weakness ranking, sprint locking, and the case filters. See [docs/exam-blueprints.md](docs/exam-blueprints.md).

`src/features/encounter`, `src/features/debrief` and `src/features/settings` have jsdom tests for the redesigned encounter, voice cost states, debrief and display settings, including axe checks. `server/api/notes.test.ts` covers learner notes and annotations, including leakage scans. See [docs/accessibility.md](docs/accessibility.md).

**Browser tests (opt-in).** `npm run test:e2e` runs Playwright against a real server (port 8788, test database, AI disabled) and Vite (port 5180). It covers a keyboard-only full case at 360 px, microphone denial, offline then sync, downtime mode, both themes at 100% and 150% text, axe including contrast, and horizontal overflow. `npm run test:audit` captures the UX audit screenshots and measurements. It needs `npm run db:up`. Install the browser once with `npx playwright install chromium`.

**Running the tests.**

- API and playthrough tests need Postgres: `npm run db:up` first.
- Use Node 22 or newer (`.nvmrc`). On Node 25, jsdom tests (`src/features/`, `src/voice/`) fail with `localStorage.setItem is not a function` because Node's experimental Web Storage global shadows jsdom's. Run them with `NODE_OPTIONS=--no-experimental-webstorage npm test`.
- HTTP tests bind one server per app to `127.0.0.1` through `server/test/http.ts` (`listenLocal`). Do not pass a bare `createApp()` to supertest: its default opens a fresh server on the IPv6 wildcard for each request, and on macOS a request can occasionally reach another local process on the same port, which shows up as stray 401 or 404 responses.
