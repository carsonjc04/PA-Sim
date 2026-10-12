# Learning analytics

The progress dashboard (`/dashboard`) tells a student what to work on next and why. It is computed from stored events on every request (`GET /api/analytics/dashboard`). There is no separate analytics table, pipeline or vendor, so the dashboard cannot drift from the records it describes.

**It does not estimate readiness, predict exam results, or compare the student with anyone.** See `docs/readiness-calibration-protocol.md` for what would have to be true first.

## 1. Rules every statement follows

- **Traceable.** Each metric result and each priority carries `evidence: EvidenceRef[]`. An `EvidenceRef` is `{ source, id, at }`, which points at one stored row (§2). A test (`server/api/analytics.test.ts`) checks that every reference resolves to a row owned by the student, with a matching timestamp.
- **Sample size is shown.** Every rate carries `n`, the number of distinct cases (or cards), and a sufficiency tier (§4).
- **Small samples are labelled.** Below the `limited` tier the value and interval are `null`, and the UI says "Not enough evidence yet" instead of a percentage.
- **Exposure is not proficiency.** "How much you have practiced an area" and "how well it went" are separate fields and separate columns.
- **Deterministic.** The same events give the same dashboard, whatever order the rows arrive in. Recommendations follow fixed rules (§6) and are covered by tests.
- **Versioned.** Every metric has an id and a version (§5). The response includes `analyticsVersion` and `metricVersions`.
- **No benchmarks.** There are no national averages, percentiles or peer comparisons. The only external numbers are the blueprint's published category weights.

## 2. Event dictionary

These are the stored rows analytics reads. Analytics writes nothing.

| `EvidenceRef.source` | Table and key | Written by, and when | Clock | Retries and duplicates | Late arrival |
| --- | --- | --- | --- | --- | --- |
| `attempt` | `attempts.id` (uuid), with `attempt_results` | `POST /api/attempts` creates it (`created_at`). `POST /api/attempts/:id/submit` grades it and sets `submitted_at`. | Server app clock (`server/lib/clock.ts`) | One active attempt per case. Submitting twice returns the stored result. | n/a: written at submit |
| `attempt_event` | `attempt_events.id` (bigserial); `(attempt_id, seq)` is unique | `POST /api/attempts/:id/events` (guided) or `POST /api/live/tool` (voice). Analytics reads `type = 'action'`, `phase = 'diagnosis'` rows, including retracted ones. | Server app clock | `Idempotency-Key` is required. A replay returns the stored response and inserts nothing. A live action is unique per `(attempt, phase, action)`. | The event's own `created_at` is used |
| `remediation_evidence` | `remediation_evidence.id` (uuid); `(attempt_id, rubric_item_id)` is unique | Derived from the pinned case and confirmed selections at submit, or by the lazy backfill (`server/review/service.ts`). | Server app clock | The unique key plus the `remediation_derivations` claim make derivation idempotent. | Bucketed by the attempt's `submitted_at`, not by derivation time |
| `learning_event` | `learning_events.id` (bigserial). Only `type = 'retention'` rows are read. | When a rating is saved for a card that was reviewed before (`docs/remediation.md` §6). | Server app clock | At most one of each type per card per session. The rating itself is idempotent by key. | Placed by `at`, the review time |

Other inputs, which are not events:

- `content_versions.definition`: the pinned case snapshot. It supplies the case title and taxonomy tags of the version that was played.
- `remediation_derivations.remediation_version`: which mapping version derived the misses.
- `review_cards`: the due queue, from the same function the review page uses (`dueKnowledge`).
- `content/blueprints/*.json`: category weights. The default is `nccpa-pance-2025`.
- `content/knowledge/library.json`: learning objectives.

### Fields derived from events

- **Diagnosis changes.** A newly confirmed primary diagnosis retracts the previous one (`attempt_events.retracted_at`). Each confirmed diagnosis row after the first counts as one change.
- **Confidence changes.** `attempt_events.detail.confidenceHistory` is a list of `{confidence, at}`, appended each time the same diagnosis is re-confirmed with a confidence. `detail.confidence` keeps the latest value, which is what grading uses. Rows written before this field existed have only `confidence`, and are read as a one-entry history.
- **Time to decision.** The first confirmed diagnosis row's `created_at`, and the kept row's `created_at`, each minus `attempts.created_at`. `attempts.created_at` is when the case was opened, so the time includes reading the presentation and any pause.

### Late events, retries and zones

- Each metric sorts its input before computing. Arrival order never changes a result.
- Every row is placed by its own timestamp. A review recorded late lands in the week it happened.
- Weeks start Monday at 04:00 in the zone the browser sends (`timeZone`), the same cutoff the review queue uses (`src/domain/review/day.ts`). The same instant can fall in different weeks for different zones, and that is intended.
- Retries never add rows (see the table), so they cannot change a count.

## 3. What counts as an attempt

Only submitted attempts with derived misses are counted. If derivation has not run, the dashboard runs the same backfill the review page does. Any attempt still not derived is reported in `totals.notYetAnalyzed` and left out, never read as clean.

## 4. Sufficiency

Case-based rates (`src/domain/analytics/sufficiency.ts`). The unit is a submitted attempt:

| Tier | Rule | Shown |
| --- | --- | --- |
| `none` | 0 attempts | "No attempts yet" |
| `insufficient` | 1–2 attempts, **or any number of attempts of only one case** | Counts only |
| `limited` | 3 or more attempts across 2 or more cases | Rate and an 80% Wilson interval |
| `adequate` | 6 or more attempts across 3 or more cases | Rate and an 80% Wilson interval |

Retrieval rates use reviews of previously seen cards: `limited` needs 5 or more reviews across 2 or more cards; `adequate` needs 20 or more across 5 or more cards.

Weekly task-clean rates count each attempt as five task observations, but sufficiency still counts attempts and cases. Five tasks from one case are not five independent pieces of evidence.

These thresholds are product heuristics and need review by a PA educator.

## 5. Metric registry

Definitions live in `src/domain/analytics/definitions.ts`. Each has an id, a version, its sources, a plain-language formula and its parameters. `src/domain/analytics/metric-lock.json` fingerprints the formula, sources and parameters of each version.

**To change a metric:**

1. Edit it.
2. Bump its `version`.
3. Bump `ANALYTICS_VERSION`.
4. Run `npm run analytics:lock`.

The lock test fails if a definition changes at the same version, and the lock script refuses to overwrite a locked fingerprint. Labels and descriptions are not fingerprinted.

| id | v | What it computes |
| --- | --- | --- |
| `area.exposure` | 1 | Attempts and distinct cases per blueprint content category (crosswalk match on the played version's tags) and per task. The five tasks the encounter phases evidence get exposure; the others (health maintenance, foundational science, professional practice) are labelled "not measured by cases". |
| `area.proficiency` | 1 | Share of an area's attempts with no miss evidencing it. Content category: no miss at all. Task: no miss in a phase mapped to the task (`PHASE_TASKS`, `src/domain/study/recommend.ts`). |
| `objective.evidence` | 1 | Per learning objective: attempts that could show it, and attempts with a miss mapped to it. Attempts derived under a superseded mapping version keep their misses but are dropped from the denominator. Only objectives the student has practiced toward are listed, so an unplayed case's objectives are never hinted at. |
| `error.frequency` | 1 | `remediation_evidence.error_type` counts and distinct attempts. An error type is recurring at 2 or more attempts. |
| `critical.safety` | 1 | Critical and unsafe items by case. An item is resolved once a later attempt of the same case does not repeat it. |
| `decision.timing` | 1 | Time to the first and to the kept diagnosis, as median and quartiles; diagnosis and confidence changes. |
| `retrieval.retention` | 1 | Recalled divided by n over `retention` events, beside the mean FSRS retrievability (the scheduler's expected recall). |
| `retrieval.workload` | 1 | Cards due by the end of today's study day, and how many of them were already overdue. |
| `blueprint.coverage` | 1 | Each content category is `not-authored`, `not-attempted` or `attempted`, plus the blueprint weight in each status. |
| `trend.weekly` | 1 | Per study week: attempts, distinct cases, clean task observations and recall, each with its own n and sufficiency. |
| `recommendation.priorities` | 1 | The rules in §6. |

## 6. Recommendation rules (`recommendation.priorities@1`)

Candidates are ranked by kind, in this order:

1. **Critical safety.** An unresolved critical or unsafe item → retry that case.
2. **Due retrieval.** Any cards due today → open the review page ("Start a quick 5" when more than 5 are due).
3. **Weak area.** An area at `limited` or `adequate`, with a miss rate above 0. Score = miss rate × blueprint weight. → the area's case never played, or the one played longest ago.
4. **Recurring error.** An error type in 2 or more attempts → that miss in the most recent debrief.
5. **Coverage gap.** An authored but unattempted content category. Score = weight. → a case in it.
6. **Thin evidence.** A content category at `insufficient` with an authored case → one more case.

Within a kind, ties break by score (descending), then weight (descending), then id. At most two of each kind are kept, and the first three are shown. The "why" sentence is built only from the metric values behind the priority. Tests in `src/domain/analytics/analytics.test.ts` fix the expected output for representative cases.

## 7. Privacy

The limits in `docs/remediation.md` §7 apply unchanged:

- pseudonymous ids only
- no free text, transcripts, device identifiers or third parties
- every row is deleted with its user

Analytics adds no new storage. The dashboard is shown only to the student it describes. It must not be used for grading or ranking, or be shared with a program or instructor, unless that use is designed and consented separately.

## 8. Known gaps and decisions needed

- **Thresholds and ranking.** The sufficiency tiers and recommendation order are heuristics; review them with a PA educator.
- **Unmapped objectives.** Learning objectives exist only for cases with authored remediation, which is only the respiratory case today. Other cases contribute to area metrics but not to objectives.
- **Superseded mappings.** The remediation mapping used at derivation time is not kept, only its version. An attempt derived under an older mapping cannot show objective evidence for its clean items.
- **Opening time.** Time to decision starts when the case is opened, not at the first question, so a pause before starting counts toward it.
- **Voice confidence.** Voice sessions do not record diagnosis confidence (`docs/remediation.md` §8), so confidence changes come from the guided flow only.
- **Week start.** Weeks start on Monday. Whether students want another start day, or rolling windows, is open.
