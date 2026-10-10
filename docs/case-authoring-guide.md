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
| `content/taxonomy.json` | Controlled vocabulary for tags (author-recalled, unreviewed). |
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

## 11. Taxonomy and coverage

Tags come from `content/taxonomy.json` and are `author-proposed-unreviewed` until a reviewer confirms them. The coverage report only lists which tags the cases carry. **It is not coverage of the NCCPA PANCE blueprint or of any end-of-rotation blueprint**, and a handful of cases cannot be.

## 12. What learners can and cannot see

Learners see the scenario summary, action labels, references (title, organization, link) and a coarse label: "Requires clinician review". Lifecycle, reviews, notes, waivers, taxonomy, fingerprints and the answer key never reach the browser; the bundle check and the leakage tests enforce this. Maintainers read `docs/content-status.md` or run `npm run content:validate`.
