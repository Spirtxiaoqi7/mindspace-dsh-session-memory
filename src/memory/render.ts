/** Model-facing rendering of the current session-memory document. */

import type { SessionMemoryView } from './types.ts'

function list(label: string, values: readonly { readonly text: string }[]): string {
  return values.length === 0 ? '' : `${label}\n${values.map(value => `- ${value.text}`).join('\n')}`
}

/** Render only durable user-controlled personalization; raw compaction already lives on the message surface. */
export function renderSessionMemory(view: SessionMemoryView): string {
  const { document } = view
  const relationship = document.relationship === null ? '' : [
    'Current relationship and purpose for this conversation:',
    `- Role: ${document.relationship.role}`,
    `- Mission: ${document.relationship.mission}`,
    document.relationship.guidance.length === 0 ? '' : `- Guidance: ${document.relationship.guidance}`,
  ].filter(Boolean).join('\n')
  const override = document.summaryOverride === null ? '' : `User-edited session summary:\n${document.summaryOverride}`
  const roleplayPreset = document.roleplayPreset?.enabled === true
    ? `User-authored roleplay preset for this conversation only:\n${document.roleplayPreset.text}`
    : ''
  return [
    'Session-local personalization. Apply it only in this conversation and do not infer it for other sessions.',
    override,
    list('User preferences:', document.preferences),
    list('User facts:', document.userFacts),
    list('Instructions from the user about how the assistant should behave:', document.assistantInstructions),
    relationship,
    roleplayPreset,
  ].filter(Boolean).join('\n\n')
}
