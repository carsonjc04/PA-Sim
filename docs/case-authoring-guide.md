# Case authoring guide

How to write, version and hand off a ClinicSim case. Cases are data: no
component or grading code changes when you add one.

> **Educational software.** Nothing here is clinically approved until a
> qualified reviewer says so in a pull request. Do not write "approved" into a
> case yourself, do not invent a reviewer, and do not use real patient data.

## 1. Quick start

1. Copy [`content/template/scenario.template.json`](../content/template/scenario.template.json)
   to `content/scenarios/<your-id>.json`, and the matching `.fixtures.json` beside it.
2. Replace every `REPLACE` marker. Keep the status `draft`.
3. Add the case to [`content/manifest.json`](../content/manifest.json) with `published: false` while drafting.
4. Run `npm run content:validate`. Fix errors; read warnings.
5. Fill in the fixtures (section 8), then `npm run content:lock` when the version is final.
6. Run `npm run content:coverage` to refresh the generated reports, then `npm run typecheck && npm run lint && npm test`.
7. Open a pull request. `content/` is CODEOWNERS-protected.

## 2. Files

| File | Purpose |
| --- | --- |
| `content/manifest.json` | Package version, grading version, and the list of cases. |
| `content/scenarios/<id>.json` | One `ScenarioDefinition`. |
| `content/scenarios/<id>.fixtures.json` | Four reviewable playthroughs with expected scores. |
| `content/taxonomy.json` | Controlled vocabulary for tags. Organ systems and tasks follow the PANCE blueprint; IDs are permanent. |
| `content/taxonomy-history.json` | Append-only list of every taxonomy ID ever published. |
| `content/blueprints/<id>.json` | One official exam blueprint version with source, checksum and dates. See [exam-blueprints.md](exam-blueprints.md). |
| `content/sprints/<id>.json` | A differential sprint assembled from an existing case. |
| `content/lock.json` | Fingerprint of every released version. Never edit by hand. |
| `docs/content-coverage.md`, `docs/content-status.md` | Generated. Do not edit. |

## 3. IDs

- Lowercase kebab-case: `ask-flank-pain`.
- **Unique across the whole case**: an action, diagnosis, plan option, omission or critical rule may not share an ID with another. (An old collision let a diagnostics action score as a plan option.)
- Renaming an ID is a **breaking change**. Stored attempts keep their old IDs because they are pinned to the snapshot they started on; only new attempts get the new ones.

## 4. Phases and rubric

- Exactly five phases, in order: `history`, `exam`, `diagnostics`, `diagnosis`, `treatment`.
- History, exam and diagnostics need at least one action. Diagnosis options live in `diagnoses`; treatment, disposition, counseling, return and follow-up live in `planOptions`. Do not list actions under the diagnosis or treatment phase.
- Every case needs at least two diagnoses (exactly one `primary`, equal to `correctPrimary`), at least one `treatment` option and one `disposition` option.
- `omissions[].when` lists the IDs that satisfy the omission; it is filed under the phase those IDs belong to.
- Scoring is deterministic and starts from the shared weights in `src/domain/grading.ts`. Authors only choose `effects`. The validator runs the real grader and requires a passing path that selects every positive, safe option.

### Unsafe options and critical rules

- Mark dangerous plan options `unsafe: true` with an `unsafeReason`.
- Every unsafe plan option must either be the target of a **critical rule** (caps the score at 59 and fails the attempt) or carry a **`criticalWaivers`** entry with a reason. Waivers are visible in the status report and block approval. Severity is a clinical decision; ask the reviewer.
- A critical rule may only target an option that is flagged unsafe or scores negatively.

### Action rules

`rule.requires/excludes/unlocks/hides` are validated statically (targets exist, no cycles, no contradictions, prerequisites come from the same or an earlier phase). **No runtime engine reads them yet**, so do not depend on them for behavior.

## 4a. Spoiler safety

Learner-visible text (`summary`, `patient.demographics`, `opening`, `initialInfo`, image alt text) must not name the answer. List synonyms in `spoilerTerms` (the validator also checks the diagnosis label and ID). Question wording in `paText` may name a condition; the validator warns so you can confirm it is intentional.

## 5. Clinical images

None ship today. When one is added, each entry in `clinicalImages` needs:

- `alt`: a real description, at least 10 characters, not "image". Set `decorative: true` with empty `alt` only for non-clinical images.
- `longDescription` (40+ characters) for ECGs, radiographs and photos.
- `revealedBy`: the ID of the student action that releases it. Alt text must not name the diagnosis.
- `licenseSource`: where it came from and under what license.
- An `https://` or site-root `src`.

## 6. Writing teaching text

- Write your own words, one short sentence each (300 characters maximum). No URLs in teaching text.
- References are provenance, not copy sources. Do not paste or closely paraphrase a source. Cite where a point can be checked.

## 7. References and provenance

Each reference needs the real publisher and title, an https URL, and `accessedAt`.

- `publishedOrUpdated` only when the source states a date. **Never guess.** An absent date is correct.
- `verified: true` only after you opened the source and confirmed the title.
- `specificity: "case-specific"` means the cited section supports this case. A general landing page is `general` and earns a warning.
- Placeholder organizations are rejected.

## 8. Fixtures

Each case ships four deterministic playthroughs: `happy-path`, `wrong-path`, `critical-safety-miss`, `partial-credit`. They run through the real server path in `server/content/playthrough.test.ts`.

1. Write the `selections` and a one-line description.
2. Leave `expect` zeros, run `npm run content:validate`, and read the reported grading values.
3. Check that each value is clinically sensible, then copy it into `expect`. Do not accept the grader's numbers without reading them.

If a case has no critical rule yet (it relies on a waiver), its `critical-safety-miss` fixture records current behavior: unsafe options are flagged but the score is not capped.

## 9. Versions and the lock

`lifecycle.contentVersion` is semantic:

- **MAJOR**: IDs renamed or removed, or scoring inputs changed incompatibly.
- **MINOR**: new actions, options or rubric entries.
- **PATCH**: wording, typos, reference metadata.

Add a `changeLog` entry for each version and mirror the version in the manifest and the fixtures file. After the version is final, run `npm run content:lock`. From then on, any change to learner-visible content at the same version fails validation. Review administration (status, reviews, open items, due date, changelog) is excluded from the fingerprint, so recording a review never forces a bump.

## 10. Lifecycle and review

`status` is `draft`, `clinical-review`, `approved` or `retired`.

- New cases and all five current cases are **draft**. Move to `clinical-review` only when a named process is actually under way.
- **`approved` is set only in a pull request that a designated maintainer merges**, and only when the same pull request records an `approved` review of that exact version from a qualified role: `PA-C`, `MD`, `DO`, `NP` or `PharmD`. A `PA-student` review is valid for realism and pacing feedback but never satisfies the guard.
- Reviews store the role, date, version and scope. **Never a name.**
- Approval also requires no open items, no waivers, verified references (at least one case-specific) and taxonomy marked `reviewed`.
- `nextReviewDue` defaults to 12 months. An overdue review is a warning and does not remove the case.
- To retire a case, set `status: retired` and `published: false` in the manifest. Past attempts and debriefs keep loading from their pinned snapshot; new attempts get a 410.

## 11. Taxonomy, blueprints and coverage

Read [exam-blueprints.md](exam-blueprints.md) for the model. In short:

**Tagging a case** (`taxonomy` block). All values come from `content/taxonomy.json` and must be `active`. Deprecated IDs are rejected (`taxonomy-deprecated`).

- `organSystems` (content axis) and `panceTasks` (task axis) are independent. Tag what the learner actually does in this case, not everything the condition touches.
- `topicTags` only when an EOR category needs it (for example `breast`, `trauma-acute-care`, `psych-anxiety`, `pregnancy-prenatal`). Leave it empty if unsure; an untagged topic shows as a gap, which is honest.
- `eorRotations`: the rotations the case genuinely suits. Rotation coverage counts only cases tagged for that rotation.
- `suitability` is required: `modes` (`osce` only today; `clinical-sim` is rejected until that mode exists), `learnerLevel`, `estMinutes`, `voiceReady`.
- `blueprintReviews`: add `{ blueprintId, reviewerRole, reviewedAt }` only when a qualified reviewer has checked the tags against that exact blueprint version. Never a name. This is the only thing that can make the product say a blueprint is aligned, and only when every in-scope case has one.
- Tags are part of the content fingerprint: retagging a case is a content change and needs a version bump.

**Changing the vocabulary.**

- Add a term to `content/taxonomy.json` *and* append its ID to `content/taxonomy-history.json` (`taxonomy-history-stale` otherwise).
- Never delete or rename a term (`taxonomy-id-removed`). Set `status: "deprecated"` and `replacedBy` with active IDs; stored attempts keep resolving through it.

**Adding a blueprint revision.**

1. Download the official PDF; record its URL, landing page, retrieval date and `shasum -a 256`. Do not commit the PDF and never use remembered or third-party numbers.
2. Add `content/blueprints/<issuer>-<exam>-<rotation>-<version>.json`. Copy the exact source wording about dates into `dateNotes`; leave a date `null` when the source does not state it.
3. Set `supersedes` on the new file and `supersededBy` plus `effectiveUntil` on the old one. Lifecycle (current, legacy, retired) is derived from the dates.
4. Crosswalk every content category to canonical tags. Add topic tags if needed (see above).
5. `npm run content:validate`: row, column and total checks catch most transcription slips. Keep `transcription.verifiedBy: null` until a second person re-checks every number, then record their role and date.
6. `npm run content:coverage` and commit the regenerated report.

**Differential sprints** (`content/sprints/<id>.json`) contain no clinical text.

- They list `findingActionIds` (2–6 history, exam or diagnostics actions of the source case, whose authored responses become the findings) and `optionIds` (3–5 of the case's diagnosis options, including the correct one).
- `sourceContentVersion` must equal the case version. Bumping the case makes the sprint stale (`sprint-stale`) until someone re-checks it.
- A finding that names the answer is rejected (`sprint-spoiler`). Sprints stay `draft`; learners see "Draft, not clinically reviewed".

**Coverage reports.** `docs/content-coverage.md` lists tags and, per blueprint, which categories at least one case touches. **This is not coverage of the NCCPA PANCE blueprint or of any end-of-rotation blueprint.** A full-length exam is never offered until every official cell can be filled with distinct approved items.

## 12. What learners can and cannot see

Learners see the scenario summary, action labels, references (title, organization, link) and a coarse label: "Requires clinician review". Learners also see a case's canonical organ systems, tasks and rotations (for filtering) and its suitability. Lifecycle, reviews, notes, waivers, topic tags, blueprint reviews, fingerprints and the answer key never reach the browser; the bundle check and the leakage tests enforce this. Maintainers read `docs/content-status.md` or run `npm run content:validate`.

## 13. Review content: knowledge components and prompts

Graded misses become review cards only for cases that have a remediation file. Currently only `respiratory` has one. The other cases record each miss as `unmapped`, and learners see "Review not yet authored for this case". The model, rules and scheduler are described in [remediation.md](remediation.md).

**Checklist for adding review content to a case** (`<id>` is the scenario id):

1. **List what can be missed.** Every rubric item that can become a miss needs a mapping:
   - omissions;
   - negatively scored or `unsafeReason` actions;
   - unsafe, `unsafeReason` or negatively scored plan options;
   - critical rules;
   - each distractor diagnosis;
   - the synthetic `guessed-correct`.

   `npm run content:validate` reports any that are missing (`remediation-unmapped`) or stale (`remediation-stale-mapping`).
2. **Reuse knowledge components first.** Look in `content/knowledge/library.json` for an existing KC before adding one. A student has one card per KC across all cases, so shared KCs merge evidence instead of duplicating cards.
3. **Add any new objectives or KCs to the library.**
   - IDs are kebab-case.
   - `panceTasks` and `organSystems` must come from `content/taxonomy.json`.
   - Changing a KC that another case already uses changes that case's remediation fingerprint, so bump its `remediationVersion` too.
4. **Create `content/remediation/<id>.json`:**
   - `scenarioId`, `remediationVersion: "0.1.0"` and `provenance: "author-proposed-unreviewed"`;
   - `mappings`: `{ "<rubricItemId>": { "kcIds": [...], "errorType"?: ... } }`. Override `errorType` only when the default rules in remediation.md §3 mislabel the miss. For example, the respiratory "ask for antibiotics immediately" action is a `communication-lapse`.
5. **Write prompts:**
   - Every mapped KC needs at least one prompt in this file, and should have two or more of different types (`recall`, `discrimination`, `next-best-step`, `differential`).
   - Discrimination and differential prompts need `choices`.
   - Explanations are at most 300 characters. No URLs; sources belong in the case's `clinicalReferences`.
   - Prompt IDs are unique across all remediation files.
   - Write prompts that test the knowledge component, not this patient's specifics, so they still teach after the case is replayed.
   - Prompts are shown only after the student has submitted this case, so naming the diagnosis is allowed.
6. **Validate and lock.** Run `npm run content:validate`. When final, run `npm run content:lock` (it appends a `remediation` entry) and `npm run content:coverage`. Editing a locked remediation file later requires a `remediationVersion` bump.
7. **Test.** `npm test` runs:
   - the miss-derivation consistency check;
   - the acceptance test, which requires every miss of every fixture to reach a `linked` state for authored cases.
8. **Review.** Treat prompts like teaching text: AI-drafted or author-proposed content stays `author-proposed-unreviewed` (shown to learners as draft) until a qualified reviewer checks it. Then set `provenance: "reviewed"` and bump the version.
