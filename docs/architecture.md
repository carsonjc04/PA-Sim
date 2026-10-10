# ClinicSim architecture

## Modes

| Mode                | Needs                            | Status                                                                        |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| Guided              | Backend + Postgres + an identity | Working. Every click is recorded and graded by the server.                    |
| Voice (handcrafted) | The above + `OPENAI_API_KEY`     | Conversation works. Tool calls record into the same attempt as guided clicks. |
| Voice (generated)   | —                                | Not started.                                                                  |

Without `OPENAI_API_KEY` the app still runs and guided mode is fully usable.
Without `DATABASE_URL` the server starts, but attempt routes return `503
database_unavailable`. Guided mode **no longer runs offline**: the browser no
longer holds scenario data or grading.

## Layers

```
React (src/App.tsx, src/features)      no scenario data, no grading, no SQL
  └─ src/api/client.ts                 typed fetch, idempotency keys, retries
       └─ HTTP  (src/api/contracts.ts: Zod request schemas + response types)
            └─ server/api/*            parse + authorize; no SQL
                 └─ server/attempts/service.ts     transactions, rules, grading
                      ├─ server/tools/execute.ts   pure tool validation
                      ├─ src/domain/grading.ts     pure, deterministic scoring
                      └─ server/attempts/repository.ts   the only SQL
                           └─ Postgres (server/db/migrations)
```

Boundaries are enforced, not just conventional:

- `.oxlintrc.json` forbids non-test browser code from importing `server/**`,
  `pg`, `server/content`, `domain/grading` or `domain/schema`.
- `npm run build` runs `scripts/check-bundle.ts`, which fails if any answer-key
  field name, hidden case text, unperformed finding or prompt marker appears
  in `dist/assets/*.js`.
- `src/api/contracts.ts` imports only types and Zod. It is shared by server
  validation and browser typing.

There is one grading implementation, `src/domain/grading.ts`. Only the server
calls it.

## Data model

Migration `0001_attempts.sql`:

| Table              | Purpose                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`            | `(auth_provider, external_subject)` is unique. Holds a display name only.                                                                                                                                         |
| `content_versions` | Immutable snapshot of a scenario. `id = <scenarioId>@<sha256[:12]>` of its canonical JSON; `definition` is server-only.                                                                                           |
| `grading_versions` | One row per `GRADING_VERSION` used to grade.                                                                                                                                                                      |
| `attempts`         | Owner, scenario, pinned `content_version_id`, status, current and locked phases, `next_seq`. At most one `active` attempt per user and scenario.                                                                  |
| `attempt_events`   | Append-only, ordered by `seq`: `action`, `phase_locked`, `live_started`. Each event records phase, action ID, kind, confirmed flag, revealed text and source. Retracting sets `retracted_at` and deletes nothing. |
| `idempotency_keys` | `(attempt_id, key)` maps to the request hash and stored response.                                                                                                                                                 |
| `attempt_results`  | One row per attempt. Holds grading version, content version, input digest, scores and the full `GradingResult`.                                                                                                   |

Migration `0002_content_version_metadata.sql` adds `content_semver`,
`manifest_version` and `lifecycle_status` to `content_versions`. They are NULL
for rows written before Phase 3. Snapshots stored before schema 2.0 are read
through `server/content/legacy.ts`, which fills the missing administrative
fields at read time and never rewrites the stored row.

**Why results stay explainable after content changes.**

- An attempt is pinned to the `content_version_id` that existed when it
  started.
- Submission grades against that stored definition, never the current file.
- The result row records `grading_version_id` and an `input_digest` covering
  grading version, content version and confirmed selections.
- Editing a scenario creates a new content version. Old attempts and
  debriefs keep the old one.
- `GRADING_VERSION` is pinned by an inline snapshot in `grading.test.ts`. Any
  change to scoring behavior fails that test until the version is bumped.

**Migrations.** `server/db/migrate.ts` applies `NNNN_name.sql` files in order:

- Each file runs in its own transaction, under a Postgres advisory lock, so
  concurrent deploys are serialized.
- Each applied file is recorded in `schema_migrations` with a SHA-256 checksum.
- The runner refuses to start if:
  - an applied file was edited;
  - the database has a version this build does not know;
  - the files have numbering gaps.
- The server runs pending migrations at startup; `npm run db:migrate` runs
  them by hand.

## API

All `/api/attempts` and `/api/live` routes require an `AuthContext`.

| Route                                      | Behavior                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/status`                     | Provider, availability, `insecure` flag and current display name.                                                           |
| `GET /api/scenarios`                       | Public catalog built by allowlist.                                                                                          |
| `POST /api/attempts` `{scenarioId}`        | Resumes the active attempt (200) or creates one pinned to current content (201). Concurrent starts converge on one attempt. |
| `GET /api/attempts?limit&cursor&status`    | History, newest first. Keyset pagination on `(created_at, id)`; the cursor is opaque.                                       |
| `GET /api/attempts/:id`                    | Public attempt. `debrief` is present only after submission.                                                                 |
| `POST /api/attempts/:id/events`            | Requires an `Idempotency-Key` header. Body is one of `action`, `lock_phase` or `retract`.                                   |
| `POST /api/attempts/:id/submit`            | Grades once; later calls return the stored result.                                                                          |
| `POST /api/live/session`, `/api/live/tool` | Voice. Take an `attemptId` with the same ownership check.                                                                   |

Errors always have the shape `{ error: { code, message, requestId } }`. The
codes are listed in `ApiErrorCode`.

**Authorization.**

- Every repository read and write of an attempt includes `user_id` in its
  `WHERE` clause.
- Another user's attempt, a missing attempt and a malformed ID all return the
  same `404 attempt_not_found`, so probing reveals nothing.

**Idempotency and retries.**

- An event runs in one transaction that holds `SELECT … FOR UPDATE` on the
  attempt row.
  - Same key and same body: the stored response is returned unchanged.
  - Same key, different body: `409 idempotency_conflict`.
  - A new key for an action already recorded in that phase: it is reported as
    a duplicate and never scored twice. A partial unique index enforces this
    in the database as well.
- Submit takes the same row lock. If a result row exists, it is returned.
  Concurrent submits produce exactly one `attempt_results` row.
- The browser client retries only idempotent requests (reads, keyed events,
  submit), and always with the same key.
- Diagnosis and plan drafts in the guided UI stay in the browser until the
  student locks the phase or submits. Refreshing mid-phase loses only those
  drafts. Recorded actions and locked phases survive refresh, restart and new
  devices.

## Authentication

`server/auth/context.ts` defines `AuthContext` (`userId`, `provider`,
`displayName`) and the `AuthProvider` interface. Routes see only `AuthContext`.

| `AUTH_PROVIDER`  | Behavior                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `none` (default) | Every attempt route returns `401 auth_unavailable`. The UI shows "Sign-in not available".                                                                                                                                                                                                                                                  |
| `dev`            | Trusts the `X-Dev-User` header (`^[a-z0-9][a-z0-9._-]{1,31}$`) and creates the user on first use. **Not authentication.** Refused when `NODE_ENV=production` unless `ALLOW_DEV_AUTH_IN_PRODUCTION=true`. In that case every response carries `X-ClinicSim-Insecure-Auth`, the server logs a warning, and the UI shows a persistent banner. |

A real provider (OIDC or a session cookie) implements `AuthProvider` and maps
its subject to `users.external_subject`. Nothing else changes.

## Legacy browser history

Earlier builds stored attempts in `localStorage` under `clinicsim-attempts-v1`.
**They are not imported**, because a silent import would be unsafe:

- **Ownership can't be proven.** The browser data has no identity, and the dev
  provider proves none. Whoever is "signed in" on a shared or borrowed browser
  would take over someone else's results.
- **The scores can't be trusted.** They were computed in the browser, which
  also held the answer key, so anyone could edit them. Importing them would put
  forged scores into server-owned history, which is supposed to be
  authoritative.
- **They can't be re-graded.** They have no content-version reference. Re-grading
  against today's scenarios could silently change historical scores.

The UI offers only to delete the local data. A future import would need real
authentication, explicit user consent per record, and re-grading against a
known content version, with imported rows clearly labeled.

## Content package

Cases live in `content/` (see `docs/case-authoring-guide.md`): a versioned
`manifest.json`, one JSON `ScenarioDefinition` and one fixtures file per case,
`taxonomy.json`, and `lock.json` with a fingerprint per released version.
`ScenarioDefinition` and its stable IDs remain the canonical contract.

- `server/content/validate.ts` is a pure function used by the CLI
  (`npm run content:validate`), the server startup guard and the build.
- `server/content/startup-check.ts` runs first in `server/index.ts`. An invalid
  package makes the process exit non-zero before the app, database or listener
  load. `CONTENT_DIR` is honoured outside production only.
- `npm run build` starts with `content:check` (strict validation plus a check that
  the generated reports are current), so an invalid package cannot ship.
- Two identities per snapshot: `contentVersionId` (`<id>@<hash>`, exact) and
  `lifecycle.contentVersion` (semantic, human-readable). The grading version is
  stored on each result.
- Lifecycle, reviews, notes, waivers, taxonomy and open items are maintainer
  data. They never enter a projection. Learners get a coarse label only.
- Retired cases stay in the manifest with `published: false`. They disappear
  from the catalogue and `POST /api/attempts` returns 410 `scenario_retired`;
  stored attempts still load from their pinned snapshot.

## Hidden state

The browser receives only allowlisted projections built in
`server/attempts/projection.ts`:

- `toPublicScenario`, `toPublicAttempt`, `toPublicDebrief` and
  `toAttemptSummary` name the fields to include. A field added to the schema
  later cannot leak because someone forgot to delete it.
- **Never sent:** `correctPrimary`, `criticalRules`, `criticalWaivers`, `omissions`, `effects`, `lifecycle`, reviews, reference notes, `taxonomy`,
  `rule`, `unsafeReason`, scoring weights, content `definition`, unperformed
  action `response`s, prompts, and system events (e.g. live session details).
- **Before submission:** no debrief.
- **After submission:** the debrief comes from the **stored** result. It
  contains the correct diagnosis label and reasoning, the ideal plan, critical
  messages, and feedback about the student's own choices. Unchosen options'
  unsafe reasons and teaching points stay hidden.

Tests enforce this:

- `server/attempts/projection.test.ts` and `server/api/attempts.test.ts` run
  key scans and text scans over every response type, before and after submit.
- `scripts/check-bundle.ts` scans the production bundle.

## Tools

Tool arguments carry **IDs only**. `planTool` in `server/tools/execute.ts` is
pure. It checks each call against the attempt's **pinned** scenario for:

- Zod shape;
- the tool matching the current phase;
- the phase not being locked;
- the ID existing in that phase.

Diagnosis, treatment, disposition and follow-up require `confirmed: true`.
Unconfirmed selections are returned as `pendingConfirmation` and are never
recorded. A newly confirmed diagnosis replaces the previous one.

## Grading

`gradeAttempt` is pure and deterministic.

- The service derives an `Attempt` from the confirmed, non-retracted events and
  grades it against the pinned content.
- The result is stored once and returned on every later read or submit.
- A critical safety error always sets `passed: false` and caps `finalScore` at 59. No AI output may change this.

## Known limitations

- **Session length is advertised, not enforced.** `MAX_LIVE_SESSION_MINUTES`
  is reported, but nothing closes a session when it elapses.
- **Rate limiting keys on `req.ip`** with no `trust proxy` setting, so behind a
  hosting proxy every client may share one bucket. The bucket map is in memory.
- **The browser still relays voice tool calls.** The server validates every ID
  and records idempotently by call ID. But a modified client can call
  `/api/live/tool` for its own attempt with any valid ID, so whether the student
  actually _said_ it is not verified.
- **`STORE_TRANSCRIPTS`, `OPENAI_VOICE` and `OPENAI_DELEGATION_MODE`** have no
  effect beyond being reported. Transcripts are never stored.
- **No attempt abandon or delete endpoint.** To start over, a student finishes
  and replays the attempt.

## Voice transport

The browser creates the offer; the server creates the session. `POST
/api/live/session` receives `{ sdp, attemptId }`, checks that the caller owns the attempt,, calls `openai.live.create`
with the patient instructions and Responses delegation, and returns only
`{ sessionId, sdp }`.

Ordering matters in two places. The `oai-events` data channel is created
**before** the offer so it is negotiated in the same SDP. And the UI does not
report "live" until `session.started` arrives — the HTTP response only means the
session was created. There is no `session.start` event on the WebRTC path;
creating the session starts it.

Audio rides the media tracks, not the data channel. The client never sends
`session.input_audio.append` and never expects `session.output_audio.delta`.

Transcript deltas are fragments, not turns, and the two speakers overlap because
the session is full duplex. `TranscriptAggregator` therefore accumulates each
speaker independently, extending that speaker's open segment or starting a new
one after a pause, then orders segments by start time.

### Tool calls

Delegated tool calls arrive wrapped in a `response.event` envelope whose real
type is nested at `event.type`. A completed `response.output_item.done` carrying
a `function_call` is relayed to `POST /api/live/tool`, recorded through the same
attempt service as guided clicks (idempotency key `voice:<call_id>`), and returned as a `function_call_output`. `response.create`
is sent only once every outstanding output has been supplied.

The browser is a relay, not an authority: it forwards the call and carries the
result back. All validation and hidden state stay on the server, so a
server-side sideband WebSocket can take ownership later without the encounter
components changing. Only one path may execute a given tool.

Voice and guided input share one attempt, so locking a phase in the guided UI
also unlocks the matching voice tools, and both are graded from one event log.

### Prompt boundaries

The patient prompt contains only patient-knowable facts. The answer key is never
included, so the model cannot reveal what it was never given. Exam findings and
test results are withheld too — a patient does not know their own lung sounds —
and are released only by tools. The delegated reasoning prompt enforces clinical
consistency and is explicitly forbidden from sounding like a preceptor.

## Threat model

**Assets**

- The answer key, rubric and teaching content.
- Patient prompts.
- `OPENAI_API_KEY` and the billed voice minutes it pays for.
- Each user's attempt history and scores.
- The integrity of server-graded results.

**Actors**

- A student using the app normally.
- A curious student using dev tools or crafting requests.
- Another user of the same deployment.
- Anyone on the internet who can reach the API.
- The voice model, whose tool calls are untrusted input.

| Threat                                           | Control                                                                                                                                                   | Residual risk                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Student reads answers from the bundle or network | Scenario data and grading are server-only. The lint rule blocks browser imports. Projections are allowlisted. Leak scans run in tests and on every build. | The debrief reveals the correct diagnosis and ideal plan after submission, by design. A student can submit and replay.                           |
| Student forges a score                           | Scores are computed only on the server, from server-recorded events. The browser never sends scores, findings or text. Results are stored once.           | None identified within the threat model.                                                                                                         |
| Read or modify another user's attempts           | `user_id` is in every attempt query. Access fails as a uniform 404. Tests cover cross-user access on every route.                                         | **With `AUTH_PROVIDER=dev`, identity is self-asserted.** Anyone can type another name. Acceptable only locally or on an explicitly labeled demo. |
| Replay or duplicate submissions                  | Idempotency keys with a request hash. Row locks. Unique indexes on live actions, active attempts and results.                                             | Keys are stored without expiry; the table grows with use.                                                                                        |
| Injection or malformed input                     | Zod-validated bodies, queries, headers and cursors. Parameterized SQL only. 256 KB body limit.                                                            | None identified.                                                                                                                                 |
| Model tool calls reach into hidden state         | IDs only. Each call resolves against the current phase of the pinned content. Diagnosis and plan choices need confirmation.                               | Covered in Known limitations (browser relay).                                                                                                    |
| Enumerating attempt IDs                          | Random UUIDv4. Ownership-scoped lookups. 404 regardless of cause.                                                                                         | None identified.                                                                                                                                 |
| Cost abuse                                       | Rate limit on session creation, which now also requires an owned, unsubmitted attempt.                                                                    | Rate limiting depends on proxy configuration; no per-user voice budget.                                                                          |
| PII exposure                                     | Patients are synthetic. Only a display name is stored. No transcripts. Development identities are labeled "not passwords".                                | Users could type real names as dev identities.                                                                                                   |
| Schema drift or a tampered migration             | Checksummed migrations, an advisory lock, and refusal to start on mismatch.                                                                               | Migrations are forward-only; there are no down migrations.                                                                                       |

## Not yet implemented

- **Oral defense.** The preceptor persona after submission is not built.
- **AI narrative debrief.** Deterministic feedback only for now.
- **Generated case variants.** `voice-generated` mode is still unimplemented.
- **Sideband tool execution.** Tools currently relay through the browser.

This prototype is educational. Patients are synthetic. Clinician review is
required before any curricular use.
