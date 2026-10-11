# Exam blueprints and study modes

How PA-Sim models the NCCPA PANCE and PAEA End of Rotation (EOR) blueprints, where the numbers came from, and the rules that keep the product from overstating coverage.

> **Educational software.** The blueprint numbers were transcribed from official documents and have not yet been double-checked by a second person (`transcription.verifiedBy` is `null` in every file). No case has been reviewed against any blueprint. PA-Sim must not be described as aligned to a blueprint until the alignment rule below is met.

## Sources

Each version is one file in [`content/blueprints/`](../content/blueprints/). Each file records:

- the document URL and landing page;
- the date the PDF was retrieved and its SHA-256;
- the exact wording behind its dates (`dateNotes`).

The PDFs themselves are not committed. The generated register in [content-coverage.md](content-coverage.md#blueprint-coverage) lists every version.

| Exam | Versions shipped | Source |
| --- | --- | --- |
| PANCE | Effective January 2025 | NCCPA, <https://www.nccpa.net/become-certified/pance-blueprint/> |
| EOR: Emergency Medicine, Family Medicine, Internal Medicine, Pediatrics, Psychiatry & Behavioral Health, Gynecologic, Sexual & Reproductive Health | 2026 (current) and 2018 (legacy) | PAEA, <https://paeaonline.org/assessment/end-of-rotation/blueprints-and-topic-lists> |
| EOR: Surgery | 2023 (current; no 2026 update was published) | PAEA, same page |

Retrieval notes (2026-10-11):

- **PAEA.** PAEA published the 2026 blueprints on 2026-07-27. Its page states: "Legacy blueprints will remain available for administration through July 2027." PA-Sim therefore sets `effectiveUntil` to 2027-07-31. The 2018 documents do not state a start date.
- **Women's Health rename.** PAEA lists the 2026 exam as "Gynecologic, Sexual, and Reproductive Health (formerly Women's Health)". The rotation keeps its stable ID `women-s-health`.
- **NCCPA download.** nccpa.net returned a Cloudflare challenge (HTTP 403) to automated download. The PANCE PDF was taken from the Internet Archive's capture of the official URL (2025-08-05) and recorded as `source.retrievedVia`. Its weights were cross-checked against the archived official landing page (capture 2026-09-09), which still listed the January 2025 version.
  - **To do:** download the PDF directly and confirm its SHA-256 matches `79033af4…`.

## Model

Every content item is tagged on two independent axes, plus rotation tags and suitability metadata. The case `taxonomy` block holds:

- **Content axis:** `organSystems`. The IDs are the 15 PANCE content categories.
- **Task axis:** `panceTasks`. The IDs are the 8 PANCE task categories.
- `topicTags`, for EOR categories with no PANCE equivalent. Examples: Pediatrics "Growth and Development", Surgery "Trauma/acute care", and the Psychiatry and Gynecologic, Sexual & Reproductive Health (GSRH) categories. Every topic tag names its source category.
- `eorRotations`: which of the seven core rotations the author says the case suits.
- `suitability`: modes (`osce` only for now), learner level, estimated minutes and whether the case is voice-ready.
- `blueprintReviews`: reviewer role and date per blueprint version. These are the only way to unlock an alignment claim.

**Crosswalks.** Blueprints do not share a category list. EOR blueprints use "Rheumatologic/Musculoskeletal", "Renal/Genitourinary" and "EENOT", and not every one has a Health Maintenance column. So each blueprint category carries a `crosswalk`: an `anyOf` list of clauses over canonical tags.

- A clause matches when every field it lists matches.
- A field matches when the item has any of the listed values.

**Historical stability.** Attempts are pinned to an immutable snapshot of the case version they were played on (`content_versions`).

- Study features read tags from that snapshot and resolve deprecated IDs through the current vocabulary at read time. Stored rows are never rewritten.
- Taxonomy IDs are never deleted: [`content/taxonomy-history.json`](../content/taxonomy-history.json) lists every ID ever published, and validation fails if one disappears.
- Example: the pre-2.0 split IDs `health-maintenance`, `patient-education` and `preventive-measures` are `deprecated`, with `replacedBy: ["health-maintenance-education-prevention"]`, the official merged category.

**Blueprint revisions.** A new version is a new file.

1. Set `supersedes` on the new file and `supersededBy` on the old one.
2. Record the old version's last administration date as `effectiveUntil`.

Lifecycle is derived from those dates on the day of the request:

- **current**
- **legacy:** still administrable, but a successor is current.
- **upcoming:** before `effectiveFrom`.
- **retired:** after `effectiveUntil`. Kept for history, never offered for new study, and refused by the plan endpoint with 410.

## Weights

- **PAEA** publishes item counts per content x task cell, so pair weights are official. Validation checks that every row and column of each matrix equals its stated percentage.
- **NCCPA** publishes only separate content and task percentages.
  - For PANCE pairs, PA-Sim uses content% x task% / 94, treating the axes as independent. **This is an assumption**, and the UI labels it "derived".
  - Professional Practice (6%) is not task-coded, so it stands alone as one pair.
  - The 8–10% surgical and 12–15% pediatric targets are shown as secondary targets.

## Study modes

| Mode | Route | What it does | Needs a user |
| --- | --- | --- | --- |
| Rotation | `/study/rotation/:rotationId` | Version picker (current and legacy), coverage matrix, content areas, secondary targets, due review in this blueprint, suggested cases, biggest unauthored areas | Coverage: no. Suggestions: yes |
| PANCE | `/study/pance` | Content and task weights, a system x task picker that links to `/cases?system=&task=` | Coverage: no. Suggestions: yes |
| Mixed | `/study/mixed` | Interleaved queue ranked by weakness x weight for PANCE or any current EOR blueprint | Yes |
| Differential sprint | `/study/sprint` | Short drills built from a finished case's findings and diagnosis options | Yes |

The case library accepts `?system=`, `?task=` and `?rotation=`, and offers every active value, including combinations with no cases. Those show an explicit empty state.

**Weakness.** Weakness is computed per submitted attempt from the pinned snapshot and confirmed selections, using the same miss derivation as remediation.

- A task counts as missed when any miss falls in a phase that evidences it:
  - history and exam: History and Physical;
  - diagnostics: Diagnostic Studies;
  - diagnosis: Most Likely Diagnosis;
  - treatment: Clinical Intervention and Pharmaceutical Therapeutics.
- Health maintenance, foundational science and professional practice are never observed and stay "no data".
- Weakness is the posterior mean miss rate under a Beta(1,1) prior (0.5 with no data).
- The score is weakness x weight. Consecutive entries avoid sharing a system or task.

This is a study heuristic, not a validated model, and the UI says so.

**Sprints.** Files in `content/sprints/` hold no clinical text. The stem, findings and options all come from the source case, which validation enforces (see the authoring guide).

- A sprint reveals its case's diagnosis, so it unlocks only after that case is submitted.
- Options are sorted alphabetically, and scoring happens on the server.
- Nothing is stored.

## Honesty rules (enforced in code and tests)

- **Coverage status** is only `missing` or `has-content`, never "complete".
- **Full-length exam gate.** A full-length EOR, PACKRAT, End of Curriculum or PANCE exam is never offered unless `fullExamGate` passes.
  - The gate requires every official cell to be filled by distinct `approved` items, checked as a bipartite matching so no item is used twice.
  - PANCE can never pass: the blueprint gives no exam length or matrix.
  - Today every gate is closed, and the UI shows why.
- **Alignment.** "Aligned to <blueprint>" may appear only when `alignmentClaim` is true: every in-scope published item has a `blueprintReviews` entry for that exact blueprint ID. Today it is false everywhere.
- **Transcription.** Every coverage view states when the transcription is unverified and shows the source, retrieval date and checksum.

## Decisions still needed

- A second person should re-check every transcribed number and set `transcription.verifiedBy` / `verifiedAt`.
- A clinician or educator should review the crosswalks. Examples: which canonical tags represent "Trauma/acute care", and whether GSRH "Psychiatric/Behavioral Health" should match all psychiatry cases tagged for the rotation.
- Whether the PANCE independence assumption is acceptable, or whether pair weights should be hidden for PANCE.
- How legacy versions should be chosen per learner (program setting vs. learner choice) once accounts exist.
