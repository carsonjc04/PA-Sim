export type PhaseId = 'history' | 'exam' | 'diagnostics' | 'diagnosis' | 'treatment'
export type Category = 'history' | 'exam' | 'diagnostics' | 'diagnosis' | 'treatment' | 'communication'

export interface PortraitConfig { src?: string; alt: string; fallback: string }
export interface ScoreEffect { category: Category; points: number }
export interface ActionRule { requires?: string[]; excludes?: string[]; unlocks?: string[]; hides?: string[] }
export interface Action { id: string; label: string; paText: string; response: string; kind?: 'question' | 'finding' | 'test' | 'choice'; effects?: ScoreEffect[]; rule?: ActionRule; unsafeReason?: string }
export interface Omission { id: string; phase: PhaseId; label: string; when: string[]; effects: ScoreEffect[]; feedback: string }
export interface DiagnosisOption { id: string; label: string; primary?: boolean; effects: ScoreEffect[]; reasoning?: string }
export interface PlanOption { id: string; label: string; group: 'treatment' | 'disposition' | 'counseling' | 'return' | 'follow-up'; effects: ScoreEffect[]; unsafe?: boolean; unsafeReason?: string }
export interface ScenarioDefinition { schemaVersion: string; id: string; summary: { title: string; complaint: string; age: string; pronouns: string; difficulty: 'Foundational' | 'Intermediate' | 'Urgent'; duration: string; urgent: boolean; setting: string }; patient: { name: string; demographics: string; portrait: PortraitConfig }; clinician: PortraitConfig; opening: string; initialInfo: string[]; phases: { id: PhaseId; label: string; description: string; actions: Action[] }[]; omissions: Omission[]; diagnoses: DiagnosisOption[]; planOptions: PlanOption[]; correctPrimary: string; criticalRules: { id: string; when: string[]; explanation: string }[]; teachingPoints: string[]; idealPlan: string[]; clinicalReferences: { title: string; organization: string; url: string; reviewed: string }[]; reviewStatus: 'requires-clinician-review' }
export interface Attempt { id: string; scenarioId: string; startedAt: string; completedAt?: string; selectedByPhase: Record<PhaseId, string[]>; phaseLocks: PhaseId[]; revealed: { phase: PhaseId; actionId: string; text: string }[]; submitted: boolean; rawScore?: number; finalScore?: number; passed?: boolean; feedback?: GradingResult }
export interface GradingResult { categoryScores: Record<Category, number>; rawScore: number; finalScore: number; passed: boolean; criticalSafetyError: boolean; criticalMessages: string[]; strengths: string[]; missed: string[]; unnecessary: string[]; unsafe: string[]; diagnosisReasoning: string; idealPlan: string[] }
export const phaseOrder: PhaseId[] = ['history', 'exam', 'diagnostics', 'diagnosis', 'treatment']
