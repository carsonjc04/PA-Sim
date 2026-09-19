import type { FunctionTool } from 'openai/resources/live/live'
import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'
import {
  planGroupsByTool,
  requiresConfirmation,
  toolContracts,
  toolNames,
  type ToolName,
} from './contracts'

const descriptions: Record<ToolName, string> = {
  record_history_topics:
    'Record history topics the student has asked about. Call this when the student asks the patient a history question.',
  request_physical_exam:
    'Perform a physical examination the student requested. Returns the authoritative finding; never describe an exam finding without calling this.',
  order_diagnostic_test:
    'Order a diagnostic test the student requested. Returns the authoritative result; never state a result without calling this.',
  record_communication_behavior:
    'Record a communication or bedside-manner behavior the student demonstrated.',
  propose_diagnosis:
    'Record the primary diagnosis the student stated. Set confirmed only after the student has explicitly confirmed it.',
  propose_treatment_plan:
    'Record treatment or counseling the student chose. Set confirmed only after the student has explicitly confirmed it.',
  record_disposition:
    'Record where the student is sending the patient. Set confirmed only after the student has explicitly confirmed it.',
  record_follow_up:
    'Record follow-up instructions or return precautions the student gave. Set confirmed only after the student has explicitly confirmed it.',
}

function allowedIds(scenario: ScenarioDefinition, tool: ToolName, phase: PhaseId | null): string[] {
  if (tool === 'propose_diagnosis') return scenario.diagnoses.map((d) => d.id)

  const groups = planGroupsByTool[tool]
  if (groups) {
    return scenario.planOptions.filter((p) => groups.includes(p.group)).map((p) => p.id)
  }

  const phases = phase ? scenario.phases.filter((p) => p.id === phase) : scenario.phases
  return phases.flatMap((p) => p.actions.map((a) => a.id))
}

/**
 * Argument schemas enumerate the scenario's real IDs, so the delegated model
 * cannot invent an action. The server re-validates every ID regardless; this
 * only makes a malformed call less likely.
 */
export function buildCaseTools(scenario: ScenarioDefinition): FunctionTool[] {
  return toolNames.flatMap((name) => {
    const ids = allowedIds(scenario, name, toolContracts[name].phase)
    if (ids.length === 0) return []

    const properties: Record<string, unknown> = {
      actionIds: {
        type: 'array',
        items: { type: 'string', enum: ids },
        description: 'One or more IDs from the enumerated list.',
      },
    }
    const required = ['actionIds']

    if (requiresConfirmation.has(name)) {
      properties.confirmed = {
        type: 'boolean',
        description: 'True only when the student has explicitly confirmed this selection aloud.',
      }
      required.push('confirmed')
    }

    return [
      {
        type: 'function' as const,
        name,
        description: descriptions[name],
        parameters: { type: 'object', properties, required, additionalProperties: false },
        strict: true,
      },
    ]
  })
}
