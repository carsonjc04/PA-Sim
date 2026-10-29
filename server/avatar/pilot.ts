/**
 * Cases offered Avatar + Voice. Pilot: chest-pressure only. The face is a LiveAvatar stock avatar, and the
 * case's static portrait (public/portraits/<caseId>.webp) is generated from that avatar so both modes show the
 * same fictional patient. The avatar only renders the voice session's audio; it never adds words of its own.
 */
export const AVATAR_PILOT: Readonly<Record<string, { avatarId: string }>> = {
  // LiveAvatar public avatar "David (Serious)".
  'chest-pressure': { avatarId: 'f1e41c53-5e22-43a2-bfb7-5a149a16d071' },
}

/** Sandbox mode allows only this avatar (LiveAvatar's "Wayne"); a different face, so dev only. */
export const SANDBOX_AVATAR_ID = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a'

export const avatarCaseIds = (): string[] => Object.keys(AVATAR_PILOT)
