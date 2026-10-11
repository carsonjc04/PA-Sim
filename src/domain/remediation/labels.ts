import type { ErrorType, PromptType } from './types'

/** Plain-language labels for the UI. Internal codes are never shown. */
export const errorTypeLabels: Record<ErrorType, string> = {
  'knowledge-gap': 'Knowledge gap',
  'data-gathering-omission': 'Missed data gathering',
  'interpretation-error': 'Interpretation',
  'premature-closure': 'Closed too early',
  'unsafe-action': 'Safety',
  'communication-lapse': 'Communication',
  'guessed-correct': 'Right, but unsure',
}

export const promptTypeLabels: Record<PromptType, string> = {
  recall: 'Recall',
  discrimination: 'Tell apart',
  'next-best-step': 'Next best step',
  differential: 'Differential',
}
