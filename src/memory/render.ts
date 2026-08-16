/** Model-facing rendering of the current session-memory document. */

import type { SessionMemoryView } from './types.ts'

function cards(label: string, values: SessionMemoryView['document']['preferences']): string {
  return values.length === 0 ? '' : `${label}\n${values.map(value => `- ${value.category}: ${value.text}`).join('\n')}`
}

/**
 * The session's identity-level instruction.  This replaces the scoped
 * Harness identity only when the user has explicitly assigned a role and
 * mission for this window; the caller otherwise keeps Harness' own opener.
 */
export function renderSessionMissionIdentity(view: SessionMemoryView): string | undefined {
  const relationship = view.document.relationship
  if (relationship === null) return undefined
  return [
    `You are ${relationship.role} in this conversation.`,
    `Your primary mission is: ${relationship.mission}.`,
    relationship.guidance.length === 0 ? '' : `Session guidance: ${relationship.guidance}.`,
    'This user-assigned session mission is authoritative for your role and response stance in this conversation.',
  ].filter(Boolean).join('\n')
}

/** Render only the categorized V2 personalization state; DSH compaction stays on its native message surface. */
export function renderSessionMemory(view: SessionMemoryView): string {
  const { document } = view
  const profile = document.userProfile.confirmed.length === 0 && document.userProfile.inferred.length === 0
    ? ''
    : [
      'Compact user profile for this conversation:',
      document.userProfile.confirmed.length === 0 ? '' : `- Confirmed by user: ${document.userProfile.confirmed}`,
      document.userProfile.inferred.length === 0 ? '' : `- Cautious observation, not confirmed fact: ${document.userProfile.inferred}`,
    ].filter(Boolean).join('\n')
  const roleplayPreset = document.roleplayPreset?.enabled === true
    ? `User-authored roleplay preset for this conversation only:\n${document.roleplayPreset.text}`
    : ''
  return [
    'Session-local personalization. Apply it only in this conversation and do not infer it for other sessions.',
    profile,
    cards('Categorized user preferences:', document.preferences),
    cards('Categorized instructions from the user about assistant behavior:', document.assistantInstructions),
    roleplayPreset,
  ].filter(Boolean).join('\n\n')
}
