// Fails the build if answer-key fields, hidden case text or prompts reach the browser bundle.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentPackage, scenarios } from '../server/content/scenarios'

const dir = 'dist/assets'
const bundle = readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(dir, f), 'utf8'))
  .join('\n')

const markers = [
  'correctPrimary',
  'criticalRules',
  'teachingPoints',
  'unsafeReason',
  'You are speaking with a physician assistant',
  'Hard limits',
  'OPENAI_API_KEY',
  'LIVEAVATAR_API_KEY',
  'criticalWaivers',
  'spoilerTerms',
  'nextReviewDue',
  'reviewerRole',
  'author-proposed-unreviewed',
  'pending clinical review',
  ...scenarios.flatMap((s) => [
    ...s.teachingPoints,
    ...s.idealPlan,
    ...s.diagnoses.map((d) => d.reasoning ?? ''),
    ...s.criticalRules.map((r) => r.explanation),
    ...s.omissions.map((o) => o.feedback),
    ...s.phases.flatMap((p) => p.actions.map((a) => a.response)),
    ...s.lifecycle.openItems,
    ...s.lifecycle.changeLog.map((c) => c.summary),
    ...s.clinicalReferences.map((r) => r.notes ?? ''),
  ]),
  // Review prompts are served by the API only after a case is submitted.
  ...Object.values(contentPackage().remediation).flatMap((r) => r.prompts.flatMap((p) => [p.front, p.answer, p.explanation])),
].filter((m) => m.length > 8)

const leaks = markers.filter((m) => bundle.includes(m))
if (leaks.length) {
  console.error(`Browser bundle contains ${leaks.length} hidden strings, e.g.:\n${leaks.slice(0, 5).map((l) => `  - ${l}`).join('\n')}`)
  process.exit(1)
}
console.log(`[bundle] clean: ${markers.length} hidden markers checked`)
