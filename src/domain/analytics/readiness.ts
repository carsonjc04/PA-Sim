import type { Readiness } from './types'

/**
 * There is no readiness model. This stays a constant until a model has been trained and validated on
 * outcome-linked data under docs/readiness-calibration-protocol.md, and that dataset is documented.
 * Do not replace it with a heuristic or a published score-conversion formula.
 */
export const READINESS: Readiness = {
  available: false,
  reason:
    'ClinicSim does not estimate exam readiness. No model has been validated against real exam outcomes, so any number would be a guess. Use the priorities above to decide what to practice.',
  protocol: 'docs/readiness-calibration-protocol.md',
}
