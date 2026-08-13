/** Model-facing rendering of the current session-memory document. */

import type { SessionMemoryView } from './types.ts'

function cards(label: string, values: SessionMemoryView['document']['preferences']): string {
  return values.length === 0 ? '' : `${label}\n${values.map(value => `- ${value.category}: ${value.text}`).join('\n')}`
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
  const relationship = document.relationship === null ? '' : [
    'Current relationship and purpose for this conversation:',
    `- Role: ${document.relationship.role}`,
    `- Mission: ${document.relationship.mission}`,
    document.relationship.guidance.length === 0 ? '' : `- Guidance: ${document.relationship.guidance}`,
  ].filter(Boolean).join('\n')
  const roleplayPreset = document.roleplayPreset?.enabled === true
    ? `User-authored roleplay preset for this conversation only:\n${document.roleplayPreset.text}`
    : ''
  return [
    'Session-local personalization. Apply it only in this conversation and do not infer it for other sessions.',
    profile,
    cards('Categorized user preferences:', document.preferences),
    cards('Categorized instructions from the user about assistant behavior:', document.assistantInstructions),
    relationship,
    roleplayPreset,
  ].filter(Boolean).join('\n\n')
}
