import { usePatientPortrait } from './portrait'

export function PatientPortrait({ caseId, alt, className = '' }: { caseId: string; alt: string; className?: string }) {
  const portrait = usePatientPortrait(caseId)
  if (!portrait) return null
  return <img className={`patient-portrait ${className}`} src={portrait.src} alt={alt} width={512} height={512} onError={portrait.onError} />
}
