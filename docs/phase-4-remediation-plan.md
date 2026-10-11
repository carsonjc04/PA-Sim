# Phase 4: remediation loop

**Status (2026-10-10):** built for the respiratory case. The reference is [remediation.md](remediation.md).

## Goal

Every meaningful miss in a submitted encounter produces a focused retrieval opportunity, not another passive explanation. Every graded miss has a traceable remediation state. Every due item has a deterministic reason. The daily queue works on a 360px-wide screen.

## Decisions

| # | Decision | Choice | Rationale |
| --- | --- | --- | --- |
| 1 | Where KC maps and prompts live | Sidecar files: `content/knowledge/library.json` and `content/remediation/<case>.json`, validated by `content:check`, locked in `content/lock.json` under `remediation` | Scenario JSON and its locked fingerprints stay untouched. |
| 2 | How much to author now | **Respiratory only**, marked author-proposed-unreviewed | The KC schema and prompt format are new. Prove them on one case before repeating them five times. The other cases show an honest "not yet authored" state. |
| 3 | Scheduler | `ts-fsrs` 5.4.2 pinned exactly, fuzz off, behind a `Scheduler` interface | A maintained reference implementation, deterministic with fuzz off. Upgrades replay the review log. |
| 4 | Guessed-correct signal | Optional Sure / Unsure at primary-diagnosis confirmation only, labeled "Unsure", unrecorded by default | Confidence captured before the outcome is known is free of hindsight bias, and calibration is itself a clinical skill. No per-action taps in v1. |
| 5 | Study-day boundary | 04:00 local, hardcoded; the browser's IANA zone is stored per user | Late-night study counts as "tonight". FSRS intervals stay absolute. |
| 6 | Grader | Unchanged (no `GRADING_VERSION` bump) | Misses are recomputed by `deriveMisses`, and a test checks them 1:1 against the grader on every fixture. |
| 7 | Rating UI | Reveal, then Missed it / Got it; Hard and Easy under "More options" | Low friction, with no scheduling jargon. |
| 8 | Instrumentation | First-party `learning_events`: due, shown, answered, rated, retention | Only what is needed to evaluate the loop. See the event dictionary and privacy limits in remediation.md §6–7. |

## What was built

- Domain: `src/domain/remediation/` (types, `deriveMisses`, `classifyMiss`, schemas, labels) and `src/domain/review/` (04:00-local day bucketing, due-reason text, prompt rotation).
- Server:
  - `server/review/`: scheduler, replay-based upgrades, derivation, repository, service.
  - `server/api/review.ts`.
  - `GET /api/attempts/:id/remediation`.
  - Migration `0003_remediation.sql`.
  - `npm run review:upgrade`.
- Content: KC library (4 objectives, 9 KCs) and respiratory remediation (11 mapped rubric items, 19 prompts across all four prompt types).
- UI:
  - Sure / Unsure toggle on the diagnosis step.
  - "Review plan" panel on Results with `#miss-…` anchors.
  - `/review` page.
  - Dashboard note.
  - The nav stays visible below 850px.
- Tests:
  - Unit: scheduling, time-zone and DST boundaries, guessed-correct, classification, algorithm upgrade, content validation.
  - Integration (Postgres): a missed objective becomes due; a review changes the schedule; duplicate events; no duplicate cards; resume after refresh; leakage; unmapped cases; backfill; and the acceptance check over every fixture of every case.
  - UI (jsdom): the reveal-and-rate flow.

## Follow-up (planned, not started)

1. **Author remediation for asthma, chest-pressure, dysuria and metabolic** using the checklist in [case-authoring-guide.md §13](case-authoring-guide.md#13-review-content-knowledge-components-and-prompts). Each case is a separate content change with its own review.
2. PA or clinical review of the respiratory KCs, prompts and error-type overrides, then set `provenance: reviewed`.
3. PA-student testing of the review flow: pacing, prompt quality, whether "Unsure" is used honestly.
4. Revisit FSRS weights and retention once enough `retention` events exist.
5. Consider capturing confidence in voice sessions.
