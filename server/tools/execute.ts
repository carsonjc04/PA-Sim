import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'
import { EncounterError } from '../encounters/store'
import type { EncounterRecord } from '../encounters/model'
import { planGroupsByTool, requiresConfirmation, toolContracts, type ToolName } from './contracts'

export interface ToolResult {
  tool: ToolName
  /** IDs newly recorded into the graded event log. */
  recorded: string[]
  /** IDs already present; re-sending an action never scores it twice. */
  duplicates: string[]
  /** Safety-critical selections awaiting explicit student confirmation. */
  pendingConfirmation: string[]
  /** Authorized reveal text, resolved from the locked scenario. */
  reveals: { id: string; text: string }[]
}

function resolveId(scenario: ScenarioDefinition, tool: ToolName, phase: PhaseId, id: string) {
  if (tool === 'propose_diagnosis') {
    const found = scenario.diagnoses.find((d) => d.id === id)
    return found ? { id: found.id, text: found.label } : null
  }
  const groups = planGroupsByTool[tool]
  if (groups) {
    const found = scenario.planOptions.find((p) => p.id === id && groups.includes(p.group))
    return found ? { id: found.id, text: found.label } : null
  }
  // History, exam, test and communication tools resolve against the current
  // phase only, so a tool call cannot reach into a phase the student has not
  // reached yet.
  const currentPhase = scenario.phases.find((p) => p.id === phase)
  const found = currentPhase?.actions.find((a) => a.id === id)
  return found ? { id: found.id, text: found.response } : null
}

export function executeTool(
  record: EncounterRecord,
  tool: ToolName,
  rawArgs: unknown,
): ToolResult {
  if (record.submitted) {
    throw new EncounterError('Encounter already submitted', 409, 'encounter_submitted')
  }

  const contract = toolContracts[tool]
  const parsed = contract.schema.safeParse(rawArgs)
  if (!parsed.success) {
    throw new EncounterError(
      `Invalid arguments for ${tool}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      400,
      'invalid_tool_arguments',
    )
  }

  const phase = contract.phase ?? record.currentPhase
  if (contract.phase && contract.phase !== record.currentPhase) {
    throw new EncounterError(
      `${tool} is not available during the ${record.currentPhase} phase`,
      409,
      'wrong_phase',
    )
  }
  if (record.lockedPhases.includes(phase)) {
    throw new EncounterError(`The ${phase} phase is locked`, 409, 'phase_locked')
  }

  const args = parsed.data
  const confirmed = 'confirmed' in args ? args.confirmed : true
  const needsConfirmation = requiresConfirmation.has(tool) && !confirmed

  const result: ToolResult = {
    tool,
    recorded: [],
    duplicates: [],
    pendingConfirmation: [],
    reveals: [],
  }

  for (const id of args.actionIds) {
    const resolved = resolveId(record.hidden, tool, phase, id)
    if (!resolved) {
      throw new EncounterError(
        `Unknown action "${id}" for ${tool} in this scenario`,
        400,
        'unknown_action',
      )
    }

    if (needsConfirmation) {
      result.pendingConfirmation.push(resolved.id)
      continue
    }

    if (record.events.some((e) => e.id === resolved.id && e.phase === phase)) {
      result.duplicates.push(resolved.id)
      continue
    }

    record.events.push({
      id: resolved.id,
      phase,
      kind: contract.kind,
      at: new Date().toISOString(),
      revealed: resolved.text,
      confirmed: requiresConfirmation.has(tool) ? true : undefined,
    })
    result.recorded.push(resolved.id)
    result.reveals.push({ id: resolved.id, text: resolved.text })
  }

  return result
}

/** Removes a non-critical captured action so the student can correct a misheard turn. */
export function retractEvent(record: EncounterRecord, id: string): void {
  if (record.submitted) {
    throw new EncounterError('Encounter already submitted', 409, 'encounter_submitted')
  }
  const index = record.events.findIndex((e) => e.id === id)
  if (index === -1) throw new EncounterError('Event not found', 404, 'event_not_found')
  if (record.lockedPhases.includes(record.events[index].phase)) {
    throw new EncounterError('That phase is locked', 409, 'phase_locked')
  }
  record.events.splice(index, 1)
}
