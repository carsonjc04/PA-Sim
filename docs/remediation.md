# Remediation loop and Today's Review

Every graded miss in a submitted encounter gets a traceable remediation state. Where review content has been authored, the miss also becomes a spaced-retrieval card in **Today's review**. Misses lead to retrieval practice rather than another passive explanation.

> **Status (2026-10-10).**
> - Review content exists only for **respiratory**. It is AI-drafted (`author-proposed-unreviewed`) and needs PA or clinical review.
> - The other four cases record each miss as `unmapped` and show "Review not yet authored for this case".
> - Scheduling parameters are product defaults. They have not been tuned on student data.

## 1. Flow

1. **Submit.** `submitAttempt` grades as before. In the same transaction (inside a savepoint), `deriveRemediation`:
   - recomputes id-level misses from the pinned case, the confirmed selections and the optional diagnosis confidence (`src/domain/remediation/misses.ts`);
   - stores one `remediation_evidence` row per miss;
   - for mapped misses, upserts one `review_cards` row per knowledge component (KC).

   If derivation fails, grading still succeeds. The attempt is derived lazily on the next review request.
2. **Debrief.** The Results page's **Review plan** lists every miss with its plain-language error type and state ("In today's review", "Scheduled for …", or "Review not yet authored for this case"). Each row has an anchor `#miss-<rubricItemId>`.
3. **Today's review** (`/review`):
   - Shows due cards first, oldest due first. Offers **Quick 5** when more than five are due, or **Review all**.
   - Each item: prompt, then **Show answer**, then answer, explanation, *why this is here*, and a link back to the debrief anchor.
   - Rating is **Missed it** / **Got it**, with **Hard** and **Easy** under "More options".
   - The session's order and prompts are frozen server-side, so a refresh or another device resumes at the same position.
   - There are no streaks, timers or countdowns.

## 2. Domain model

| Type | Where | Meaning |
| --- | --- | --- |
| `LearningObjective` | `content/knowledge/library.json` | A course-level objective with PANCE task tags. |
| `KnowledgeComponent` | same | The unit a card practices. It links to objectives and carries PANCE task and organ-system tags from `content/taxonomy.json`. |
| `RubricMapping` | `content/remediation/<case>.json` | rubric item id → `kcIds[]` and an optional `errorType` override. |
| `ReviewPrompt` | same | `recall`, `discrimination`, `next-best-step` or `differential`. Has front, optional choices, answer and explanation (≤300 characters, no URLs). |
| `Miss` | derived | `{ rubricItemId, kind, phase, label }`. `kind` is one of omission, unnecessary, unsafe, critical, wrong-diagnosis, guessed-correct. |
| `ErrorType` | derived or authored | See §3. |
| `RemediationItem` | `review_cards` plus `evidence_cards` | One card per user per KC, with all evidence linked. |
| `ReviewState` | `review_cards` | FSRS memory state, `due`, `due_reason`, `algorithm_version`, `params_id`. |
| `ReviewEvent` | `review_events` | Append-only record of each rating, with before and after state. |

**Traceability to the grader.** `GradingResult` stores prose only, so `deriveMisses` recomputes ids from the pinned definition. `server/content/misses.test.ts` checks it against `gradeAttempt` on every fixture:
- every `missed` line ↔ one omission;
- every `unnecessary` line ↔ one negatively scored action;
- every `unsafe` line ↔ one item carrying `unsafeReason`;
- every critical message ↔ one critical miss.

Remediation adds three things the grader scores but does not list:
- negatively scored plan options;
- a wrong primary diagnosis;
- a correct diagnosis recorded as **Unsure** (guessed-correct).

The grader and `GRADING_VERSION` are unchanged.

**No duplicate cards.** `review_cards` is unique on `(user_id, kc_id)`.
- A repeat miss adds evidence and sets `due = min(due, now)` with reason `new-evidence`. The FSRS memory state is left untouched.
- Two misses of the same KC in one attempt create one card.

## 3. Error types

An authored `errorType` on the mapping wins. Otherwise the first matching rule applies (`classifyMiss`):

1. Critical or unsafe → **unsafe-action**.
2. Guessed-correct → **guessed-correct**.
3. Wrong primary diagnosis:
   - **premature-closure** if the same attempt skipped a history or exam item;
   - otherwise **interpretation-error**.
4. Omission scored mainly (over 50%) against communication → **communication-lapse**.
5. Omission in history, exam or diagnostics → **data-gathering-omission**.
6. Anything else (unnecessary items, diagnosis or treatment omissions) → **knowledge-gap**.

Rules 3 and 6 are heuristics for an educational signal, not a validated taxonomy. Authors should override them where a case calls for it.

**Guessed-correct.**
- Captured only as an optional **Sure / Unsure** toggle at primary-diagnosis confirmation, before the outcome is known. Retrospective "I guessed" taps would carry hindsight bias.
- Skipping the toggle records nothing.
- Stored in `attempt_events.detail`, which is never projected to the browser.
- Voice sessions do not capture it.

## 4. Scheduling

`server/review/scheduler.ts` wraps **ts-fsrs 5.4.2 (FSRS-6)** behind the `Scheduler` interface (`init`, `review`, `retrievability`).

| Setting | Value | Why |
| --- | --- | --- |
| `enable_fuzz` | false | Deterministic and testable. |
| `enable_short_term` | false | The queue is daily, so a first "Got it" is scheduled days ahead, not 10 minutes. |
| `maximum_interval` | 365 days | A PA-program horizon. ts-fsrs keeps Good one day past Hard, so Good can reach 366. |
| `request_retention` | 0.9 | FSRS default. |
| weights | FSRS-6 defaults | Not yet fitted to ClinicSim data. |

- **Ratings.** 1 Again ("Missed it"), 2 Hard, 3 Good ("Got it"), 4 Easy. The UI never shows "ease", "stability" or "difficulty".
- **Versioning.** Each card and review stores `algorithm_version` (`fsrs-6/ts-fsrs@5.4.2`) and `params_id` (a hash of the parameters, saved in `scheduler_params`). A test fails if `package.json` and the pinned version drift.
- **Upgrades.** A card stamped with another version or other parameters is replayed from its append-only review log (`replayCard`). Evidence recorded after the last review re-applies its pull-forward. This happens:
  - lazily, on the user's next review request;
  - eagerly, with `npm run review:upgrade`.

  After upgrading ts-fsrs or changing parameters, bump `TS_FSRS_RELEASE` and run that script.
- **Clock.** Review code uses `server/lib/clock.ts` (`now()`, with `setClock` for tests). Review timestamps come from it, not from SQL `now()`. The grader stays clock-free.

**Study day.** "Due today" means due before **04:00 local** on the next calendar date, in the browser's IANA zone (`src/domain/review/day.ts`).
- The zone is sent with each review request and stored on `users.time_zone`.
- The server runs in UTC and never imposes its own midnight.
- Days are 23 or 25 hours long across daylight-saving changes.
- FSRS due times are absolute instants; the cutoff affects only bucketing.
- An unfinished session expires at the rollover.

**Deterministic due reasons.** `review_cards.due_reason` is one of the following, rendered by the pure `describeDueReason`:
- `new-miss`: first evidence, due immediately;
- `new-evidence`: a repeat miss;
- `scheduled`: set by the last rating.

Each code stores the attempt, rubric item and evidence it came from, so every due item traces back to a graded miss.

**Prompt rotation** (`choosePrompt`) is deterministic:
- it prefers a prompt type different from the last one shown, then a different prompt, then cycles by review count;
- prompts come only from remediation files of cases the user has **submitted**.

## 5. API

All routes require auth. Every query includes `user_id`; another user's card, session or attempt returns 404.

| Route | Behavior |
| --- | --- |
| `GET /api/review/summary?timeZone` | `{ localDay, dueToday, totalCards }`. |
| `POST /api/review/sessions` `{ mode: all\|micro, timeZone, restart? }` | Resumes today's open session, or freezes a new queue (micro = first 5). `restart` closes the open one. |
| `GET /api/review/sessions/current?timeZone` | Today's open session, for resuming, or `session: null`. |
| `POST /api/review/cards/:id/reviews` `{ sessionId, promptId, rating, latencyMs }` | Requires `Idempotency-Key`. The same key and body replays the stored response; the same key with a different body gives 409. Only the session's current item can be rated; anything else is `409 review_out_of_order`. |
| `POST /api/review/sessions/:id/events` `{ type: shown\|answered, cardId, latencyMs? }` | Client-observed moments. Recorded once per card per session. |
| `GET /api/attempts/:id/remediation?timeZone` | Per-miss state for a **submitted** attempt; `409 attempt_not_submitted` before submission. |

GET routes may write: they first backfill underived submitted attempts and upgrade stale cards. Both steps are idempotent.

**Leakage.**
- Prompts, answers and explanations are served by the API only, never bundled; `scripts/check-bundle.ts` scans for them.
- Cards exist only from submitted attempts.
- Prompts are filtered to cases the user has submitted.

## 6. Event dictionary (`learning_events`)

The only instrumentation this feature adds. It exists to evaluate whether the loop improves retention, and for nothing else.

| Type | Written when | Fields |
| --- | --- | --- |
| `due` | A card enters a newly created session. | `card_id`, `session_id`, `prompt_type`, `retrievability` (FSRS predicted recall at that moment; 0 for a new card), `at` |
| `shown` | The browser displays an item (client-reported). | `card_id`, `session_id`, `prompt_type`, `at` |
| `answered` | The student reveals the answer (client-reported). | the above plus `latency_ms` (from shown to reveal) |
| `rated` | A rating is saved. | the above plus `rating` (1–4), `latency_ms`, `elapsed_days` (since the previous review; null if none), `retrievability` (predicted recall just before this review) |
| `retention` | A rating is saved for a card reviewed at least once before. | `rating`, `elapsed_days`, `retrievability`, `recalled` (`rating > 1`) |

- Every row also has `user_id` (pseudonymous uuid) and `type`.
- A unique index allows at most one event of each type per card per session, so refreshes and retries do not double count.
- `review_events` holds the full scheduling log, used for replay. `learning_events` is the analysis view.
- The progress dashboard reads `retention` events for its recall metric. The full analytics event dictionary, covering every table the dashboard reads, is in `docs/analytics.md` §2.

**Questions this is meant to answer.**
- Do students return to due items? (`due` → `shown`)
- How long does recall take? (`answered.latency_ms`)
- Is predicted recall calibrated against observed recall? (`retention.retrievability` vs `recalled`)
- Do the four prompt types differ in recall?

## 7. Privacy limits

- **No free text.** Students reveal and rate; they never type an answer, so none is stored.
- **No transcripts.** Nothing here reads or writes voice transcripts. `STORE_TRANSCRIPTS` stays `false`.
- **No device or network identifiers.** No IP address, user agent, location or fingerprint.
- **First party only.** Events stay in the app's Postgres. There is no analytics vendor, pixel or third-party SDK.
- **Pseudonymous.** Rows reference `users.id` (uuid). The dev display name lives only on `users`.
- **Deletion.** Every remediation table cascades from `users`. Deleting a user deletes their cards, evidence, sessions, reviews and events.
- **Purpose-limited.** Use this data to evaluate and tune the remediation loop, and to show the student their own progress (`docs/analytics.md`). Do not use it for grading, ranking or anything shown to someone else.
- **Not clinical data.** Cases are fictional. Do not add real patient information to prompts or evidence.

## 8. Known limitations and open decisions

- Respiratory prompts and KC mappings need PA or clinical review before they are relied on. The UI labels them as draft.
- Error-type rules 3 and 6 are heuristics; review them with a PA educator.
- FSRS weights are defaults. Revisit once enough `retention` events exist.
- Guessed-correct is not captured in voice sessions.
- Remediation for the other four cases is not authored yet. See the checklist in `docs/case-authoring-guide.md` §13.
