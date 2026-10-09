import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'
import { ApiError } from '../http/errors'
import { planGroupsByTool, requiresConfirmation, toolContracts, type ToolName } from './contracts'

export interface ResolvedAction {
  id: string
  /** Text released to the student once the action is recorded. */
  text: string
}

export interface ToolPlan {
  phase: PhaseId
  kind: string
  confirmed: boolean
  needsConfirmation: boolean
  actions: ResolvedAction[]
}

function resolveId(scenario: ScenarioDefinition, tool: ToolName, phase: PhaseId, id: string): ResolvedAction | null {
  if (tool === 'propose_diagnosis') {
    const found = scenario.diagnoses.find((d) => d.id === id)
    return found ? { id: found.id, text: found.label } : null
  }
  const groups = planGroupsByTool[tool]
  if (groups) {
    const found = scenario.planOptions.find((p) => p.id === id && groups.includes(p.group))
    return found ? { id: found.id, text: found.label } : null
  }
  // Only the current phase resolves, so a call cannot reach into a phase the student has not reached.
  const found = scenario.phases.find((p) => p.id === phase)?.actions.find((a) => a.id === id)
  return found ? { id: found.id, text: found.response } : null
}

/** Validates a tool call against the pinned scenario and attempt state. Pure: never mutates. */
export function planTool(
  scenario: ScenarioDefinition,
  state: { currentPhase: PhaseId; lockedPhases: PhaseId[]; submitted: boolean },
  tool: ToolName,
  rawArgs: unknown,
): ToolPlan {
  if (state.submitted) throw new ApiError('This attempt is already submitted.', 409, 'attempt_submitted')

  const contract = toolContracts[tool]
  const parsed = contract.schema.safeParse(rawArgs)
  if (!parsed.success) {
    throw new ApiError(
      `Invalid arguments for ${tool}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      400,
      'invalid_tool_arguments',
    )
  }

  const phase = contract.phase ?? state.currentPhase
  if (contract.phase && contract.phase !== state.currentPhase) {
    throw new ApiError(`${tool} is not available during the ${state.currentPhase} phase.`, 409, 'wrong_phase')
  }
  if (state.lockedPhases.includes(phase)) throw new ApiError(`The ${phase} phase is locked.`, 409, 'phase_locked')

  const args = parsed.data
  const confirmed = 'confirmed' in args ? Boolean(args.confirmed) : true
  const actions = args.actionIds.map((id) => {
    const resolved = resolveId(scenario, tool, phase, id)
    if (!resolved) throw new ApiError(`Unknown action "${id}" for ${tool} in this scenario.`, 400, 'unknown_action')
    return resolved
  })

  return {
    phase,
    kind: contract.kind,
    confirmed: requiresConfirmation.has(tool) ? confirmed : true,
    needsConfirmation: requiresConfirmation.has(tool) && !confirmed,
    actions,
  }
}
