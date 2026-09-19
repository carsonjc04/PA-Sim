# ClinicSim

ClinicSim is a deterministic educational clinical-encounter simulator for physician assistant students. Students work through five fictional primary-care encounters from the PA-student perspective, then explicitly submit for rubric-based grading and debrief.

This is an educational prototype, not clinical decision support. All patients and findings are fictional and require qualified clinician review before formal educational use. Do not enter real patient information.

## Run locally

```bash
npm install
npm run dev
```

Other checks: `npm run build`, `npm run lint`, `npm test`, and `npm run preview`.

## Architecture

- `src/data/scenarios.ts` contains the five handcrafted scenario definitions.
- `src/domain/types.ts` contains canonical domain types.
- `src/domain/schema.ts` validates scenarios with Zod before a provider returns them.
- `src/providers/static.ts` implements `ScenarioProvider` and `PatientResponseProvider` without network calls.
- `src/domain/grading.ts` is pure, deterministic, idempotent grading logic.
- `src/storage.ts` stores attempts in `localStorage` under `clinicsim-attempts-v1`; malformed values recover as an empty history.
- `src/App.tsx` owns the route-level screens and encounter interaction state.

Routes: `/`, `/cases`, `/encounter/:scenarioId`, and `/results/:attemptId`.

## Scenario data and adding a sixth case

Add another `ScenarioDefinition` to `src/data/scenarios.ts` (or split the data into one module per case), using stable IDs for every phase, action, diagnosis, plan item, omission, and critical rule. Include a non-spoiler summary, clinical references, `reviewStatus: "requires-clinician-review"`, and all five phases. Run `npm test` and `npm run build`; no encounter or results component should need to change.

Rules are data-driven: action visibility can use `requires` and `excludes`, while grading refers only to stable IDs. Keep teaching text original and concise; references are metadata, not copied source material.

## Scoring

The weighted categories are History 20%, Physical examination 15%, Diagnostics and reasoning 15%, Diagnostic accuracy 20%, Treatment and follow-up 20%, and Communication 10%. Category scores are clamped from 0 to 100, the weighted total is rounded, and 70% is the normal pass threshold. A critical safety rule forces failure and caps the displayed score at 59%; both `rawScore` and `finalScore` remain on the attempt record.

Demo history is seeded only when no saved history exists. The dashboard reset control clears local storage and restores the clearly labeled demo attempts.

## Portraits

Portraits are configured in each scenario's `patient.portrait` and `clinician` objects. A future `src` can be a local or stable royalty-free asset. The portrait component falls back to configured initials with descriptive alt text when an image is missing or fails.

## Future provider seam

A pre-generated scenario provider can implement `ScenarioProvider` and return validated canonical scenarios. A live patient-response provider can implement `PatientResponseProvider` and return validated turns after each action. Provider selection should stay in `src/providers`; screens and grading should not import individual cases. See `docs/ai-integration.md`. Static providers are the only active providers.

## Clinical-content limitations

Reference metadata points to CDC outpatient antibiotic guidance, ADA Standards of Care in Diabetes—2026, GINA asthma guidance, and ACC/AHA/ACEP/NAEMSP/SCAI acute coronary syndrome guidance. The prototype has not been clinically validated, is not a curriculum, and must be reviewed by qualified clinicians before formal use.

## Tests

`src/domain/grading.test.ts` covers all five schema validations, spoiler-safe summaries, partial weighted credit, idempotence, critical-error capping, and data-driven visibility evaluation.
