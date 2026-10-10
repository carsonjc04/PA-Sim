# Phase 3 plan: versioned, auditable clinical content

Status: **answers received 2026-10-10; implementation in progress.** The
settled decisions are in [section 0](#0-decisions). Section 5 keeps the
original questions for the record.

## 0. Decisions

| Q | Decision |
| - | --- |
| 1 | Cases move to JSON under `content/` with a typed loader. |
| 2 | All five cases are `status: draft`. The learner label stays "Requires clinician review". |
| 3 | Rename the colliding action IDs: a MAJOR content bump for those cases. Grading code is unchanged. IDs are unique across the whole case from now on. |
| 4 | `ActionRule` is validated statically only (consistency and reachability). No runtime engine yet. |
| 5 | Authors bump versions by hand. Validation fails when a locked version's hash changed. The released hashes live in `content/lock.json`. |
| 6 | Every `unsafe` option needs a critical rule or a `criticalWaiver` with a reason. Three waivers read "pending clinical review". Scores are unchanged. |
| 7 | Fixtures are siblings: `content/scenarios/<id>.fixtures.json`. |
| 8 | Replace the placeholder reference with the real publisher and title. Verify dates by fetching sources. Never invent a date. Flag general sources as needing case-specific ones. |
| 9 | Approval is PR-only, with CODEOWNERS on `content/`. `PA-student` is a valid reviewer role but does not satisfy the approval guard. Only PA-C, MD, DO, NP or PharmD do. |
| 10 | Status is visible in the CLI, the coverage report and `docs/content-status.md`. There is no in-app maintainer UI. |
| 11 | Image metadata schema and validator rules only. No images are added. |
| 12 | An overdue review is a warning. Default interval: 12 months. |
| 13 | I draft the taxonomy tags and mark them `author-proposed-unreviewed`. Template only, no new cases. |
| 14 | A retired case stays in the manifest with `published: false`. History and debriefs load from the pinned rows. New attempts are refused. |
| 15 | `engines.node >=22` and `.nvmrc` = 22. |
| 16 | New `content_versions` rows are acceptable. Old attempts keep their hashes. |

Assumptions I made where the answers overlapped or were silent:

- **Versions.** Q3 asks for a MAJOR bump and Q16 says 1.0.0. The pre-Phase-3 content was unversioned, so I treat it as an implicit 1.0.0. The three cases with renamed IDs (respiratory, dysuria, chest-pressure) ship as `2.0.0`. The other two (metabolic, asthma) ship as `1.0.0`.
- **Dropped.** The `supports` field on references and the generated JSON Schema file. Neither is needed for validation.
- **Critical-safety fixtures.** Three cases have no critical rules, and Q6 keeps their scores unchanged. Their `critical-safety-miss` fixture pins the current behaviour: the unsafe option is flagged, but the score is not capped. The validator requires the fixture to expect a cap whenever a case has critical rules.
- **Maintainer.** CODEOWNERS names the repository owner, @carsonjc04.
- **Lock strictness.** An unlocked new version is a warning locally. It is an error with `--strict`, which the build uses.
- **`CONTENT_DIR`.** The environment override is honoured outside production only, so tests can prove that a broken package stops the server.

## 1. Current state (checked in the code on 2026-10-10)

| Area | What exists now | Gap for Phase 3 |
| --- | --- | --- |
| Domain contract | `ScenarioDefinition` in `src/domain/types.ts`. Zod schema in `src/domain/schema.ts`. | The schema checks shapes only. `phase.id`, effect `category` and plan `group` are plain `z.string()`, and nothing checks references between fields. |
| Content | Five TS objects in `src/data/scenarios.ts`: respiratory, dysuria, metabolic, asthma, chest-pressure. | There is no manifest, lifecycle, semantic version or taxonomy tags. |
| Lifecycle | `reviewStatus: 'requires-clinician-review'` is a literal type. | It has no reviewer role, dates or `next-review` field. |
| References | `{title, organization, url, reviewed}`. Three cases use a generic placeholder that points to a CDC outpatient antibiotic page labelled "ClinicSim faculty review set". | Provenance is weak: there is no publication date, and that label suggests a faculty review that did not happen (see Q8). |
| Versioning | `server/content/versions.ts` makes `contentVersionId = <id>@<sha256[0:12]>` from canonical JSON. `content_versions` stores the full definition. Attempts and results pin `content_version_id` and `grading_version_id`. | Historical pinning already works by hash. A human-readable semver and a manifest version need to sit beside the hash without replacing it. |
| Startup | `server/index.ts` runs migrations and then listens. Scenarios are validated lazily with `validateScenario` on each request. | Invalid content does not stop the server from starting. |
| Build | `npm run build` = `tsc -b && vite build && check-bundle.ts`, which is a leak scan for answer-key strings. | No content validation runs in the build. |
| `ActionRule` (`requires/excludes/unlocks/hides`) | It is in the type and schema. **No scenario uses it, and no engine reads it** (grading, tools and the UI all ignore it). | There are no rules to validate yet. See Q4. |
| Critical rules | Only asthma (`discharge`) and chest-pressure (`outpatient`, `discharge`, `self-drive`) have them. | Some options are flagged `unsafe` but have no critical rule: respiratory `antibiotics`, dysuria `no-treatment`, metabolic `ignore`. See Q6. |
| Review visibility | The UI hardcodes "Requires qualified clinical review before formal use." `reviewStatus` and `clinicalReferences` are sent to learners through `toPublicScenario`. | There is no maintainer view. |
| Clinical images | Every portrait has `alt` and `fallback`, and none has `src`. There are no clinical images (ECG, rash, X-ray). | Image accessibility metadata is still undefined. |

### Integrity findings from a quick probe (these become validator rules)

1. **The same ID is used by different entity types in three cases:**
   - respiratory: `strep` is both a diagnostics action and a diagnosis;
   - dysuria: `pyelo` is both a history action and a diagnosis;
   - chest-pressure: `ems` is both a diagnostics action and a plan option.

   `gradeAttempt` builds one `Set` of chosen IDs from every phase. So in
   chest-pressure, choosing the diagnostics action `ems` alone also applies the
   `ems` plan option's treatment effects: the probe gave treatment 70 with no
   treatment selected. Respiratory `strep` and dysuria `pyelo` collide in the
   same way. This is a real grading defect. Fixing it changes scores, so it
   needs a `GRADING_VERSION` bump or an ID rename (see Q3).
2. No dangling references: every `omission.when`, `criticalRules.when` and
   `correctPrimary` resolves to an ID that exists.
3. Each case has exactly one diagnosis with `primary: true`, and it matches
   `correctPrimary`.

### Baseline quality gates (run 2026-10-10, local Node v20.17.0)

- `lint` and `typecheck` are clean.
- `npm test`: 54 passed, 1 skipped. There was also **1 unhandled error**:
  `src/voice/liveClient.test.ts` failed to start. jsdom's dependency
  `html-encoding-sniffer` calls `require()` on an ESM module, which Node
  20.17 rejects (`ERR_REQUIRE_ESM`). This is an environment and runtime issue
  that already existed before Phase 3 (see Q15).

## 2. Proposed design

### 2.1 Content package layout

```
content/
  manifest.json              # versioned list of scenarios + package version
  scenarios/
    respiratory.json         # one ScenarioDefinition (+ lifecycle, tags) per file
    ...
  template/scenario.template.json
  schema/scenario.schema.json  # generated from Zod for editor autocomplete
docs/case-authoring-guide.md
docs/content-coverage.md       # generated report (committed, CI-checked for drift)
scripts/content/validate.ts    # CLI: npm run content:validate
scripts/content/coverage.ts    # CLI: npm run content:coverage
```

`ScenarioDefinition` and its stable IDs remain the canonical contract.
`src/data/scenarios.ts` turns into a thin typed loader over `content/`, so
all current imports keep working. Whether to move to JSON is Q1.

### 2.2 Manifest (`content/manifest.json`)

```jsonc
{
  "manifestVersion": "1.0.0",       // semver of the package as a whole
  "schemaVersion": "2.0",           // ScenarioDefinition schema
  "gradingVersion": "grading-…",     // must equal GRADING_VERSION
  "scenarios": [
    { "id": "respiratory", "file": "scenarios/respiratory.json",
      "contentVersion": "1.0.0", "status": "clinical-review", "published": true }
  ]
}
```

### 2.3 Lifecycle and provenance fields (added to `ScenarioDefinition`)

```ts
lifecycle: {
  status: 'draft' | 'clinical-review' | 'approved' | 'retired'
  contentVersion: string            // semver: MAJOR = ID/scoring-breaking, MINOR = new actions/text, PATCH = typo
  review: null | {
    reviewerRole: 'PA-C' | 'MD' | 'DO' | 'NP' | 'PharmD' | 'PA-student' | ...   // role only, never a name
    reviewedAt: string              // ISO date
    scope: string                   // e.g. "history + plan"
  }[]
  nextReviewDue: string             // ISO date
  changeLog: { version: string; date: string; summary: string }[]
}
references: {
  title: string; organization: string; url: string
  publishedOrUpdated?: string       // only when actually known
  accessedAt: string                // when the author looked at it
  supports: string[]                // which IDs / teaching points it backs
}[]
taxonomy: { organSystems: string[]; panceTasks: string[]; careSetting: string;
            acuity: 'routine'|'urgent'|'emergent'; ageGroup: string; eorRotations: string[] }
```

- The validator **refuses `status: 'approved'`** unless the case has a
  `review` entry with a clinician role. Even then, approval happens only in a
  human-authored commit (Q9). All five existing cases stay at the status that
  maps to "requires-clinician-review" (Q2).
- `reviewStatus` stays in the public projection as a derived, coarse label.
  Learners never see reviewer notes, `supports` mappings or the changelog
  (Q10).

### 2.4 Validation CLI (`npm run content:validate`)

The CLI is a pure function `validatePackage(manifest, files) → Issue[]` (error
or warning, with a JSON path). The CLI, the server startup and the build all
use the same function. The checks:

| # | Check |
| - | --- |
| 1 | Zod shape with enums made strict: `PhaseId`, `Category`, plan `group`, status, acuity. |
| 2 | Unique scenario IDs across the manifest. Each file's `id` matches its manifest entry. |
| 3 | Unique entity IDs within a scenario, across actions, diagnoses, plans, omissions and critical rules. This catches the three collisions above. Q3 decides between "globally unique in a case" and "unique per entity type". |
| 4 | Five-phase completeness: exactly `history, exam, diagnostics, diagnosis, treatment`, in order. Phases 1–3 have at least one action, `diagnoses` has at least 2 options, and `planOptions` covers the required groups. |
| 5 | Reachability: every action can be reached from the start state given `requires/hides`. There is at least one complete happy path, and `correctPrimary` is selectable. |
| 6 | Rule compatibility: no action both requires and excludes the same ID, no cycles in `requires`, no ID that is both unlocked and hidden by the same trigger, and every rule target exists. |
| 7 | Rubric references: `omission.when`, `omission.phase`, `correctPrimary`, `diagnoses[].primary` (exactly one, matching `correctPrimary`), and effect categories are valid. |
| 8 | Critical-rule targets exist, and every target is an `unsafe` or negatively scored option. Every `unsafe: true` option is covered by a critical rule, or explicitly waived with a reason (Q6). |
| 9 | Spoiler-safe summary: `summary.title`, `complaint`, `opening`, `initialInfo` and action `label`/`paText` must not contain the correct diagnosis label, its ID or authored synonyms (`spoilerTerms`). Distractor diagnosis labels are also checked, with a warning only. |
| 10 | Image accessibility: when an image `src` is present, it requires non-empty `alt` (not "image"), `longDescription` for clinical images, `decorative: boolean`, and a `findingsWithheldUntil` phase so the alt text does not spoil the case (Q11). |
| 11 | References: at least one per case, `https` URL, `accessedAt` date, `publishedOrUpdated` either a valid date or absent (never invented), and no placeholder organizations (Q8). |
| 12 | Lifecycle: valid semver, an approval guard, `nextReviewDue` in the future (an error, or a warning when the case is not in production, see Q12), and a semver bump whenever the content hash changes relative to the last released hash (Q5). |
| 13 | Original text heuristics: length caps on teaching points, and no long verbatim runs copied from reference titles. Real plagiarism detection is out of scope. |

### 2.5 Enforcement (acceptance criteria)

- **The server refuses to start with an invalid package.** `server/index.ts`
  calls `assertValidPackage()` before migrations and `listen()`, and exits
  non-zero with a list of issues. Render will then keep the previous healthy
  deploy.
- **A production build cannot ship with an invalid package.** The build
  becomes `content:validate && tsc -b && vite build && check-bundle`, so a
  failing package stops the Vercel build. `check-bundle.ts` also learns about
  the new hidden fields, such as reviewer metadata and `supports`.
- **Historical attempts keep the exact version.** The current
  `<id>@<hash>` pinning stays. A migration adds
  `content_versions.content_semver` and `manifest_version`, plus
  `attempt_results.grading_version_id`, which already exists. A test then
  regrades a stored attempt after a content edit and shows that the old
  result and snapshot are unchanged.
- **Review status is visible to maintainers and does not leak.** The learner
  projection keeps its allowlist and receives only a coarse status label. The
  maintainer view is behind Q10.

### 2.6 Deterministic playthrough tests

A table-driven harness (`server/content/playthrough.test.ts`) runs each
scenario through the **real server path**: create attempt, record actions,
lock phases, submit. A pure `gradeAttempt` variant also runs, for speed.
Each scenario declares five fixtures in its file, or in a sibling
`*.fixtures.json` (Q7):

| Fixture | Assertions |
| --- | --- |
| happy path | `passed`, no critical error, score ≥ threshold, primary aligned |
| plausible wrong path | wrong primary, `passed` false or lower score, the expected `missed` items appear |
| critical safety miss | `criticalSafetyError`, `finalScore ≤ 59`, the specific critical message appears |
| partial credit | a score within an authored band (e.g. 60–75), with specific omissions listed |
| hidden-state leakage | before submission, no public payload (scenario, attempt, events, live tool output) contains any `response` for actions that have not run, `correctPrimary`, `effects`, `reasoning`, teaching points or reviewer metadata |

Scores are pinned through snapshots, so any change to content or grading
shows up as a reviewed diff.

### 2.7 Coverage report (`npm run content:coverage`)

The script generates `docs/content-coverage.md`, plus JSON. It shows one row
per scenario, with columns for organ system, PANCE task, care setting,
acuity, age group, EOR rotation, status and version, and adds
count-per-category pivots. The header states plainly: *"Shows which tags the
authored cases carry. It does not show coverage of the NCCPA blueprint or
any EOR blueprint."* There are no percentages against a blueprint. CI fails
if the committed report differs from the generated one.

### 2.8 Authoring guide and template

- `docs/case-authoring-guide.md`: the lifecycle, ID rules, semver rules,
  spoiler rules, critical-rule rules, image accessibility, references as
  provenance (paraphrase, do not copy), the review handoff checklist, and how
  to run the validator and fixtures.
- `content/template/scenario.template.json`: a complete, valid,
  obviously fake case (`"id": "template-example"`, `status: draft`). It is
  validated in CI and excluded from the published manifest.

### 2.9 Proposed sequencing (each step a separate PR, gates green)

1. Validator core, strict enums and integrity checks. **Fixes or documents the
   ID collisions**, depending on Q3.
2. Lifecycle, taxonomy and reference fields on the five cases. Schema v2,
   with a v1→v2 adapter so stored `content_versions` rows still load.
3. Manifest, then moving content to `content/` (Q1). The existing hashes are
   recorded in the manifest's history.
4. Enforcement in startup and build, plus the DB migration and the
   historical-version test.
5. Playthrough fixtures and harness for all five cases.
6. Coverage report, authoring guide and template.
7. Maintainer review view (Q10), docs updates
   (`architecture.md`, `product-baseline.md`).

## 3. Explicit non-goals for Phase 3

- No case is marked `approved`. No reviewer names or credentials are
  invented.
- No claim of PANCE or EOR blueprint coverage.
- No new scenarios beyond the template, unless you request them (Q13).
- No change to voice transport, auth or cost guardrails.
- `ActionRule` gets no runtime engine unless Q4 says otherwise.

## 4. Risks

- **Changing hashes:** adding lifecycle fields to the definition changes every
  content hash. That is safe, because old rows stay pinned, but every snapshot
  test will move once.
- **Spoiler false positives:** some complaint text legitimately overlaps with
  a distractor, for example "wheezing" and asthma. Tuning will be needed, and
  waivers will need to be explicit.
- **Stale reviews:** an expired `nextReviewDue` could block a deploy. Q12
  decides how strict that should be.

## 5. Questions for you

**Q1. Content storage format.**
- A) Move the cases to JSON files under `content/`, with a typed loader *(recommended: diffable, tool-friendly, language-neutral for reviewers)*.
- B) Keep them as TypeScript in `src/data/`, split into one file per case.

Answer:

**Q2. Status of the five existing cases.** The brief says to keep them at
"requires-clinician-review", but the new enum is
`draft / clinical-review / approved / retired`.
- A) Set `status: 'clinical-review'` and have the learner label read "Requires clinician review" *(recommended)*.
- B) Set `status: 'draft'`, because nobody has reviewed them yet.
- C) Add `requires-clinician-review` as a fifth status.

Answer:

**Q3. Fixing the ID collisions (`strep`, `pyelo`, `ems`).**
- A) Rename the action IDs (for example `rapid-strep-test`, `ask-flank-pain`, `ems-ecg-prep`). This is a MAJOR content version bump. Grading code is unchanged, and old attempts keep their pinned content *(recommended)*.
- B) Change grading to scope IDs by phase or entity type. This is a `GRADING_VERSION` bump and leaves the content alone.
- C) Do both.

For the future, do you want IDs unique across the whole case (recommended) or only within each entity type?

Answer:

**Q4. `ActionRule` (requires/excludes/unlocks/hides).** No case uses it and
no engine reads it.
- A) Validate it statically now (consistency and reachability), but leave the runtime engine for the Clinical Sim milestone *(recommended)*.
- B) Build the runtime engine in Phase 3, so it is enforced in tools and the UI.
- C) Remove it from the schema until it is needed.

Answer:

**Q5. Who bumps `contentVersion`?**
- A) The author bumps it by hand, and CI fails if the content hash changed without a bump. CI compares against a committed `content/lock.json` of released hashes *(recommended)*.
- B) CI suggests the bump automatically.

Answer:

**Q6. Unsafe options without critical rules** (respiratory `antibiotics`,
dysuria `no-treatment`, metabolic `ignore`). Choosing them does not cap the
score.
- A) The validator requires each `unsafe` option to have a critical rule or an explicit `criticalWaiver` with a reason. For these three I add *waivers* that say "pending clinical review", so scores stay the same *(recommended: this is a clinical decision, not mine to make)*.
- B) Add critical rules to all three now. This changes the scores.

Answer:

**Q7. Where should playthrough fixtures live?**
- A) A sibling `content/scenarios/<id>.fixtures.json`, reviewable by clinicians along with the case *(recommended)*.
- B) Only inside the test files.

Answer:

**Q8. Placeholder references.** Three cases cite "ClinicSim faculty review
set", which points to a CDC antibiotic page. That label suggests a faculty
review that did not happen.
- A) I replace it with the actual publisher and title of the source (CDC Adult Outpatient Treatment Recommendations), leave `publishedOrUpdated` empty unless it can be verified, and flag dysuria and metabolic as needing case-specific sources *(recommended)*.
- B) You or a reviewer will supply the references. I only add validator errors.

Should I fetch the source pages to fill in titles and update dates where they
are clearly stated? (I would not copy any text.)

Answer:

**Q9. Approval workflow.** How should "approved" eventually be recorded?
- A) A PR that only a designated maintainer can merge, changing the status, with reviewer role, date and scope recorded in the file. A `CODEOWNERS` entry would cover `content/` *(recommended)*.
- B) A signed review record stored in the DB.
- C) Decide later. For now the validator blocks `approved` completely.

Also: does a PA student count as a reviewer role? I suggest yes for
realism and pacing, and no for clinical approval.

Answer:

**Q10. Maintainer visibility of review status.** There are no roles or
accounts beyond `AUTH_PROVIDER=dev/none`.
- A) For Phase 3, the status appears in the CLI, the generated coverage report and a committed `docs/content-status.md`, with no in-app maintainer UI. Learners see only the coarse label *(recommended)*.
- B) Add a `/maintainer` route gated by a server-side `MAINTAINER_TOKEN` env variable.
- C) Wait until real auth or roles exist.

Answer:

**Q11. Clinical images.** None exist today, and portraits have no `src`.
- A) Define the image metadata schema and validator rules now (alt, long description, decorative flag, reveal phase, license or source), with no images added *(recommended)*.
- B) Also add one example image (for example an ECG for chest-pressure). That would need a license-clean source.

Answer:

**Q12. When `nextReviewDue` passes:**
- A) The validator warns but does not fail. The server logs a warning, and the learner label stays "requires clinician review" *(recommended for now, because nothing is approved)*.
- B) The build fails, which forces a re-review.
- C) The case is hidden from learners automatically.

What review interval should be the default? (I suggest 12 months.)

Answer:

**Q13. Taxonomy values.** Should I draft the tags for organ system, PANCE
task, care setting, acuity, age group and EOR rotation for the five cases
myself, using NCCPA content and task category *names* as a controlled
vocabulary and marking them "author-proposed, unreviewed"? Or will you
supply the vocabulary and tags? Do you also want any new cases in Phase 3,
or only the template?

Answer:

**Q14. Retired cases.** Should a `retired` case:
- A) Stay in the manifest with `published: false`, so history and debriefs still load from the pinned `content_versions`, while new attempts are refused *(recommended)*?
- B) Be removed from the manifest entirely, so it exists only in the DB?

Answer:

**Q15. The test environment problem that already existed.**
`liveClient.test.ts` fails to start on local Node 20.17 because of jsdom and
an ESM `require`. Phase 3 will run "all quality gates".
- A) Pin `engines.node` (for example `>=20.19` or 22 LTS) and add `.nvmrc`, so the gates are reliable *(recommended)*.
- B) Leave it as is. You will upgrade Node locally.
- C) Pin or downgrade jsdom.

Which Node version do Render and Vercel use for you?

Answer:

**Q16. Hash continuity.** Adding fields changes every content hash, even
where clinical content is unchanged. Is it acceptable that the first Phase 3
deploy creates new `content_versions` rows (`1.0.0`) for all five cases,
while existing attempts stay on their old hashes? *(Recommended: yes.)*

Answer:
