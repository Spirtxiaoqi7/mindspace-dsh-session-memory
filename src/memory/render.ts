/** Model-facing rendering of the current session-memory document. */

import type { SessionMemoryView } from './types.ts'

function cards(label: string, values: SessionMemoryView['document']['preferences']): string {
  return values.length === 0 ? '' : `${label}\n${values.map(value => `- ${value.category}: ${value.text}`).join('\n')}`
}

/** Render only categorized personalization; it never replaces the agent's identity. */
export function renderSessionMemory(view: SessionMemoryView): string {
  const { document } = view
  const profile = document.userProfile.confirmed.length === 0 && document.userProfile.pendingConfirmation.length === 0
    ? ''
    : [
      'Compact user profile for this conversation:',
      document.userProfile.confirmed.length === 0 ? '' : `- Confirmed by user: ${document.userProfile.confirmed}`,
      document.userProfile.pendingConfirmation.length === 0 ? '' : `- Pending confirmation; revise or promote only when later user evidence supports it: ${document.userProfile.pendingConfirmation}`,
    ].filter(Boolean).join('\n')
  const relationship = document.relationship === null ? '' : [
    'Current relationship state for this conversation:',
    `- Status: ${document.relationship.status}`,
    document.relationship.context.length === 0 ? '' : `- Current context: ${document.relationship.context}`,
    '- This state is descriptive and revisable. It is not a permanent identity, mission, or obligation.',
  ].filter(Boolean).join('\n')
  const roleplayPreset = document.roleplayPreset?.enabled === true
    ? `User-authored roleplay preset for this conversation only:\n${document.roleplayPreset.text}`
    : ''
  return [
    'Session-local personalization. Apply it only in this conversation and do not infer it for other sessions.',
    profile,
    cards('Categorized user preferences:', document.preferences),
    cards('Explicit requirements from the user for assistant behavior:', document.assistantRequirements),
    relationship,
    roleplayPreset,
  ].filter(Boolean).join('\n\n')
}
