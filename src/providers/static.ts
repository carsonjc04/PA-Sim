import { scenarios } from '../data/scenarios'
import { validateScenario } from '../domain/schema'
import type { ScenarioDefinition } from '../domain/types'
export interface ScenarioProvider { listScenarios(): Promise<ScenarioDefinition[]>; getScenario(id:string): Promise<ScenarioDefinition> }
export interface PatientResponseProvider { getResponse(input:{scenarioId:string;actionId:string}): Promise<{text:string}> }
export const staticScenarioProvider: ScenarioProvider = { async listScenarios(){ return scenarios.map(validateScenario) }, async getScenario(id){ const found=scenarios.find(s=>s.id===id); if(!found) throw new Error('Scenario not found'); return validateScenario(found) } }
export const staticPatientResponseProvider: PatientResponseProvider = { async getResponse({scenarioId,actionId}) { const s=scenarios.find(x=>x.id===scenarioId); const a=s?.phases.flatMap(p=>p.actions).find(x=>x.id===actionId); if(!a) throw new Error('Action not found'); return {text:a.response} } }
// Future providers should implement these interfaces, validate all model output against the same schema,
// and leave deterministic grading authoritative over generated dialogue or scenario drafts.
