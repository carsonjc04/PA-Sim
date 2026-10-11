export type PhaseId = 'history' | 'exam' | 'diagnostics' | 'diagnosis' | 'treatment'
export type Category = 'history' | 'exam' | 'diagnostics' | 'diagnosis' | 'treatment' | 'communication'

export interface PortraitConfig { src?: string; alt: string; fallback: string }
export interface ScoreEffect { category: Category; points: number }
export interface ActionRule { requires?: string[]; excludes?: string[]; unlocks?: string[]; hides?: string[] }
export interface Action { id: string; label: string; paText: string; response: string; kind?: 'question' | 'finding' | 'test' | 'choice'; effects?: ScoreEffect[]; rule?: ActionRule; unsafeReason?: string }
export interface Omission { id: string; phase: PhaseId; label: string; when: string[]; effects: ScoreEffect[]; feedback: string }
export interface DiagnosisOption { id: string; label: string; primary?: boolean; effects: ScoreEffect[]; reasoning?: string }
export interface PlanOption { id: string; label: string; group: 'treatment' | 'disposition' | 'counseling' | 'return' | 'follow-up'; effects: ScoreEffect[]; unsafe?: boolean; unsafeReason?: string }
export type ContentStatus = 'draft' | 'clinical-review' | 'approved' | 'retired'
export type ReviewerRole = 'PA-C' | 'MD' | 'DO' | 'NP' | 'PharmD' | 'PA-student'
/** Roles whose review can support `approved`. A PA student review informs realism and pacing only. */
export const QUALIFIED_REVIEWER_ROLES: ReviewerRole[] = ['PA-C', 'MD', 'DO', 'NP', 'PharmD']
export type Acuity = 'routine' | 'urgent' | 'emergent'

/** A recorded review. Roles only: never a name or credential number. */
export interface ReviewRecord { reviewerRole: ReviewerRole; reviewedAt: string; contentVersion: string; scope: string; outcome: 'approved' | 'changes-requested' | 'comments' }
export interface ChangeLogEntry { version: string; date: string; summary: string }
export interface Lifecycle { status: ContentStatus; contentVersion: string; reviews: ReviewRecord[]; nextReviewDue: string; openItems: string[]; changeLog: ChangeLogEntry[] }
export interface ClinicalReference { title: string; organization: string; url: string; accessedAt: string; publishedOrUpdated?: string; specificity: 'case-specific' | 'general'; verified: boolean; notes?: string }
export type PracticeMode = 'osce' | 'clinical-sim' | 'sprint'
export interface Suitability { modes: PracticeMode[]; learnerLevel: 'didactic' | 'clinical' | 'both'; estMinutes: number; voiceReady: boolean }
export interface BlueprintReview { blueprintId: string; reviewerRole: string; reviewedAt: string }
export interface Taxonomy { provenance: 'author-proposed-unreviewed' | 'reviewed'; organSystems: string[]; panceTasks: string[]; topicTags?: string[]; careSetting: string; acuity: Acuity; ageGroup: string; eorRotations: string[]; suitability: Suitability; blueprintReviews?: BlueprintReview[] }
export interface ClinicalImage { id: string; src: string; kind: 'ecg' | 'xray' | 'photo' | 'diagram' | 'other'; alt: string; longDescription?: string; decorative: boolean; revealedBy: string; licenseSource: string }
export interface CriticalWaiver { optionId: string; reason: string }

export interface ScenarioDefinition { schemaVersion: string; id: string; summary: { title: string; complaint: string; age: string; pronouns: string; difficulty: 'Foundational' | 'Intermediate' | 'Urgent'; duration: string; urgent: boolean; setting: string }; patient: { name: string; demographics: string; portrait: PortraitConfig }; clinician: PortraitConfig; opening: string; initialInfo: string[]; phases: { id: PhaseId; label: string; description: string; actions: Action[] }[]; omissions: Omission[]; diagnoses: DiagnosisOption[]; planOptions: PlanOption[]; correctPrimary: string; criticalRules: { id: string; when: string[]; explanation: string }[]; criticalWaivers: CriticalWaiver[]; spoilerTerms: string[]; teachingPoints: string[]; idealPlan: string[]; clinicalReferences: ClinicalReference[]; clinicalImages?: ClinicalImage[]; taxonomy: Taxonomy; lifecycle: Lifecycle }
export interface Attempt { id: string; scenarioId: string; startedAt: string; completedAt?: string; selectedByPhase: Record<PhaseId, string[]>; phaseLocks: PhaseId[]; revealed: { phase: PhaseId; actionId: string; text: string }[]; submitted: boolean; rawScore?: number; finalScore?: number; passed?: boolean; feedback?: GradingResult }
export interface GradingResult { categoryScores: Record<Category, number>; rawScore: number; finalScore: number; passed: boolean; criticalSafetyError: boolean; criticalMessages: string[]; strengths: string[]; missed: string[]; unnecessary: string[]; unsafe: string[]; diagnosisReasoning: string; idealPlan: string[] }
export const phaseOrder: PhaseId[] = ['history', 'exam', 'diagnostics', 'diagnosis', 'treatment']
