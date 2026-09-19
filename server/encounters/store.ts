import { randomUUID } from 'node:crypto'
import { scenarios } from '../../src/data/scenarios'
import { validateScenario } from '../../src/domain/schema'
import type { ScenarioDefinition } from '../../src/domain/types'
import type { EncounterMode, EncounterRecord } from './model'

export const PROMPT_VERSION = '2026-09-19.1'

/**
 * In-memory. A browser refresh keeps the encounter because state lives on the
 * server, but a server restart drops active encounters. See docs/architecture.md.
 */
const encounters = new Map<string, EncounterRecord>()

export class EncounterError extends Error {
  status: number
  code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function getScenario(id: string): ScenarioDefinition {
  const found = scenarios.find((s) => s.id === id)
  if (!found) throw new EncounterError('Scenario not found', 404, 'scenario_not_found')
  return validateScenario(found)
}

export function listScenarios(): ScenarioDefinition[] {
  return scenarios.map(validateScenario)
}

export function createEncounter(input: {
  scenarioId: string
  studentId: string
  mode: EncounterMode
  liveModel: string
  reasoningModel: string
  scenario?: ScenarioDefinition
}): EncounterRecord {
  const hidden = input.scenario ?? getScenario(input.scenarioId)
  const record: EncounterRecord = {
    id: randomUUID(),
    studentId: input.studentId,
    mode: input.mode,
    scenarioId: hidden.id,
    hidden,
    schemaVersion: hidden.schemaVersion,
    promptVersion: PROMPT_VERSION,
    liveModel: input.liveModel,
    reasoningModel: input.reasoningModel,
    currentPhase: 'history',
    lockedPhases: [],
    events: [],
    createdAt: new Date().toISOString(),
    submitted: false,
  }
  encounters.set(record.id, record)
  return record
}

export function requireEncounter(id: string): EncounterRecord {
  const found = encounters.get(id)
  if (!found) throw new EncounterError('Encounter not found', 404, 'encounter_not_found')
  return found
}

export function deleteEncounter(id: string): void {
  encounters.delete(id)
}

/** Test seam only. */
export function resetEncounters(): void {
  encounters.clear()
}
