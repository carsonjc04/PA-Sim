import { env } from '../config/env'

/**
 * The patient's voice per case, chosen by listening against the patient's age and sex (and, on the avatar
 * pilot, the avatar's face). A case not listed here uses OPENAI_VOICE, then the provider default (`marin`,
 * which reads as a younger woman), so a new case with a male patient needs an entry.
 */
export const PATIENT_VOICES: Readonly<Record<string, string>> = {
  'chest-pressure': 'echo', // 64-year-old man; also voices the avatar pilot's face
  metabolic: 'cedar', // 52-year-old man
}

/** The voice for a case's patient, or undefined to leave the provider default. Fixed for the whole session. */
export function patientVoiceFor(caseId: string): string | undefined {
  return PATIENT_VOICES[caseId] ?? (env.OPENAI_VOICE || undefined)
}
