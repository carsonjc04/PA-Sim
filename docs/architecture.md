# ClinicSim architecture

## Modes

| Mode | Needs a key | Status |
| --- | --- | --- |
| `guided` | No | Working. The existing deterministic, button-driven encounter. |
| `voice-handcrafted` | Yes | Working. Full-duplex WebRTC conversation with an AI patient. |
| `voice-generated` | Yes | Not started. Bounded variants of approved blueprints. |

With no `OPENAI_API_KEY` the app installs, builds, tests and runs, and guided
mode is fully usable. `POST /api/encounters` refuses a voice mode with `503`
rather than pretending a session exists.

## Layers

```
src/domain/     pure TypeScript: types, Zod schema, deterministic grading
src/data/       the five clinician-authored scenarios
server/config/  Zod-validated env; sole accessor for the API key
server/encounters/  encounter record, hidden state, public projection
server/tools/   Zod tool contracts and server-validated execution
server/api/     HTTP routes
```

`src/domain` and `src/data` have no DOM dependencies, so the server imports the
**same** grading engine the client uses. There is one scoring implementation,
not two that can drift.

## Hidden state

An encounter holds the complete `ScenarioDefinition` as `record.hidden`. The
browser never receives it. `toPublicEncounter` builds the response by explicit
**allowlist** — it names the fields to include rather than deleting the ones to
hide, so a sensitive field added to the schema later cannot leak by being
forgotten.

Withheld before submission: `correctPrimary`, `criticalRules`, `omissions`,
`idealPlan`, `teachingPoints`, every `effects` array, `unsafe` / `unsafeReason`,
diagnosis `reasoning`, and action `response`.

An action's `response` is released only by executing that action, so the
patient's answers cannot be read ahead from the payload.

`server/encounters/projection.test.ts` enforces this two ways: a structural
check that no forbidden key appears anywhere in the serialized payload, and a
text scan for hidden strings. The text scan skips secrets that are substrings of
legitimately public option labels — publishing every option reveals nothing
about which one is correct.

## Tools

Tool arguments carry **IDs only**. Scores, findings and display text are never
accepted from a model; the server resolves them from the locked scenario. Every
call is checked for: valid Zod shape, the tool matching the current phase, the
phase not being locked, and the ID existing in the current phase. History, exam,
test and communication tools resolve against the current phase only, so a call
cannot reach into a phase the student has not started.

Execution is idempotent — replaying an action returns it as a duplicate and
never scores it twice.

Diagnosis, treatment, disposition and follow-up require `confirmed: true`.
Without it the selection is returned as `pendingConfirmation` and never enters
the graded event log, so no safety-critical decision can rest on a speech
classifier's guess.

## Grading

`gradeAttempt` in `src/domain/grading.ts` is authoritative and pure. The server
derives an `Attempt` from the confirmed event log and grades it. Same log, same
grade, every time — resubmitting returns an identical result.

A critical safety error always sets `passed: false` and caps `finalScore` at 59,
regardless of raw score. No AI output may alter this.

## Known limitations

- **Encounters are in-memory.** A browser refresh keeps the encounter because
  state lives on the server, but a server restart drops active encounters.
- **Guided mode still ships scenario data in the browser bundle.** That is
  pre-existing, offline by design, and required for no-key operation. Only the
  server path is rigorous about hidden state; the voice modes use it.
- **No GPT-Live transport yet.** See below.

## Voice transport

The browser creates the offer; the server creates the session. `POST
/api/live/session` receives `{ sdp, encounterId }`, calls `openai.live.create`
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
a `function_call` is relayed to `POST /api/live/tool`, executed against hidden
state on the server, and returned as a `function_call_output`. `response.create`
is sent only once every outstanding output has been supplied.

The browser is a relay, not an authority: it forwards the call and carries the
result back. All validation and hidden state stay on the server, so a
server-side sideband WebSocket can take ownership later without the encounter
components changing. Only one path may execute a given tool.

### Prompt boundaries

The patient prompt contains only patient-knowable facts. The answer key is never
included, so the model cannot reveal what it was never given. Exam findings and
test results are withheld too — a patient does not know their own lung sounds —
and are released only by tools. The delegated reasoning prompt enforces clinical
consistency and is explicitly forbidden from sounding like a preceptor.

## Not yet implemented

- **Oral defense.** The preceptor persona after submission is not built.
- **AI narrative debrief.** Deterministic feedback only for now.
- **Generated case variants.** `voice-generated` mode is still unimplemented.
- **Sideband tool execution.** Tools currently relay through the browser.

This prototype is educational. Patients are synthetic. Clinician review is
required before any curricular use.
