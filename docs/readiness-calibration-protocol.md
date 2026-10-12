# Readiness estimation: calibration protocol

**Status: not started. ClinicSim shows no readiness estimate, pass probability, or exam score prediction.**

This document says what has to be true before one could be shown. Until every gate in §10 is met and signed off, `READINESS.available` in `src/domain/analytics/readiness.ts` stays `false`. A guard test (`scripts/analytics/claims.test.ts`) fails the build if prediction language appears in shipped code.

The numbers below are starting points for a statistician and the PA program to revise. They are not validated thresholds.

## 1. Why there is no estimate today

- ClinicSim holds practice data only. It has no exam outcomes, so nothing can be checked against reality.
- The case bank is small and unreviewed against any blueprint (see `docs/content-coverage.md`). Practice performance on a handful of cases does not sample the exam.
- A number that looks precise but is wrong can make a student stop studying, or make them panic. Both cause harm. Showing no number does neither.

## 2. PACKRAT and other score conversions

No PACKRAT-to-PANCE formula, conversion table or rule of thumb is used in production. The formula that circulates among students is anecdotal: it has no published derivation, it is not issued by PAEA or NCCPA, and its error is unknown. It must not be added as a feature, a tooltip, a default or a "fun estimate". If PACKRAT scores are ever used, they are a candidate *input feature* under this protocol, with student consent, and they get no special treatment.

## 3. Target outcome

- **Primary:** first-attempt PANCE result (pass or fail), as a binary outcome.
- **Source:** either reported by the student, with explicit consent and a date, or verified by the institution under a data agreement. Record which source each label came from. Self-reported labels are analysed separately as a sensitivity check.
- **Not targets:** scaled score, EOR scores, or PACKRAT. They may be secondary outcomes in a later protocol version.
- The outcome date must be recorded, because the leakage controls in §6 depend on it.

## 4. Cohort eligibility

- PA students in an accredited program, aged 18 or over, who have practiced in ClinicSim before their first PANCE attempt.
- A minimum activity bar for inclusion is set **before** looking at outcomes, for example at least 10 submitted attempts across at least 5 cases in the 6 months before the exam. Students below the bar are reported as excluded, with counts.
- Exclude test accounts, staff accounts and development identities.
- Exclude students who withdrew consent (see §5).

## 5. Consent

- Opt-in only, separate from the terms of use, and in plain language: what is collected, what it is used for, who can see it, and how long it is kept.
- Consent can be withdrawn at any time. Withdrawal deletes the outcome label and removes the student from future training sets. Models already trained are retrained at the next scheduled recalibration.
- No outcome is ever inferred, scraped or bought.
- Institutional review (IRB or equivalent) before any data collection, if the institution requires it.
- The privacy limits in `docs/remediation.md` §7 and `docs/analytics.md` still apply: pseudonymous IDs, no free text, no transcripts.

## 6. Leakage controls

- **Feature freeze:** every feature is computed only from events with timestamps before a cutoff that is at least 7 days before the exam date. Nothing recorded after the exam is used.
- **Per-student split:** all of a student's data is in exactly one of train, validation or test.
- **No outcome-derived features:** for example, nothing that depends on whether the student later retook the exam.
- **Content drift:** features are computed from the pinned content versions that were played (`attempts.content_version_id`), using the metric versions in `src/domain/analytics/definitions.ts`. Record the metric versions used to build each dataset.
- **Selection:** students who opt in may differ from those who do not. Report how the cohort compares with the program's published pass rate, and do not claim the model generalises beyond the cohort.

## 7. Minimum sample and data split

- **Minimum:** at least 300 labelled outcomes overall, with at least 50 failures, before any model is fit. Fewer failures than that cannot support a calibration claim at the low end, which is where the estimate matters most.
- **Subgroups:** at least 50 outcomes in every subgroup reported in §8. Subgroups below that are reported as "not enough data", never pooled away quietly.
- **Split:** a temporal split. Train on earlier graduation cohorts, validate on the next, and hold out the most recent cohort as the test set. Within that, split by student, never by attempt.
- **Pre-registration:** the features, model family, minimum activity bar and evaluation metrics are written down before the test set is opened.

## 8. Evaluation

Report all of the following on the held-out test cohort. A model that fails any of them is not shown.

- **Calibration plot:** predicted against observed pass rates in deciles (or in fewer bins if needed, each with at least 30 students), with 95% intervals for each bin.
- **Brier score**, compared with a base-rate-only baseline (always predicting the cohort pass rate). The model must beat the baseline by a margin set in pre-registration.
- **Calibration slope and intercept.**
- **Discrimination (AUC)** is reported but is secondary. A well-discriminating but miscalibrated model is not acceptable.
- **Subgroup error review:** calibration and Brier score by program, cohort year, first-generation status and other attributes the program can lawfully provide with consent. Report any subgroup where error is materially worse. A model that is systematically worse for a subgroup is not shown to anyone until that is fixed.

## 9. How an estimate would be shown, if ever

- As a **range**, never a single number. For example, "Students with practice patterns like yours passed at rates between 78% and 91% in past cohorts", with the interval from the model and the cohort it came from.
- With the cohort size, the date range and the model version, all visible.
- Next to the learning priorities, never instead of them. The estimate does not change what the student should practice next.
- **Never deterministic language.** No "you will pass", "you are ready", "you will fail", "guaranteed" or any equivalent. The guard test checks shipped code for these phrases.
- Never shown to anyone other than the student, never used for grading or ranking, and never shared with a program without separate consent.
- Hidden when the student's own data is below the cohort's minimum activity bar, with the reason stated.

## 10. Go/no-go gates

All are required, and each is recorded in this document with a date and the reviewer's role.

1. The dataset is documented: its source, consent basis, inclusion counts, exclusions, label sources and metric versions.
2. The pre-registration is written and dated before the test set is opened.
3. The §8 results meet the pre-registered thresholds, including subgroups.
4. A statistician or psychometrician has reviewed the analysis.
5. A PA educator has reviewed the wording and the display.
6. The display copy passes the claims guard test without new allowlist entries.

## 11. Recalibration schedule

- Recalibrate at least once a year, after each new outcome cohort.
- Recalibrate immediately when the PANCE blueprint changes (`content/blueprints/`), when NCCPA changes scoring or the pass standard, or when any metric used as a feature changes version.
- If calibration on the newest cohort falls outside the pre-registered tolerance, withdraw the estimate (set `available: false`) until the model is refit and passes §8 again.

## 12. Ownership

A named owner role (for example, the product lead together with the program's assessment lead) is accountable for the go/no-go decision and for withdrawing the estimate. Until that role is assigned, the answer is no-go.
