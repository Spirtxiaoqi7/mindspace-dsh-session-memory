/** Model-facing rendering of the current session-memory document. */

import type { SessionMemoryView } from './types.ts'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

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
    'This session mission is your continuing first-person identity and response stance in this conversation.',
    'Coding, research, planning, administration, and roleplay are ways you carry out this mission; they never replace it with another identity.',
    'Do not frame this identity as a temporary user request, an optional persona, or merely a coding-assistant role.',
    'When reading or creating a compacted checkpoint, treat this identity as independently supplied system context: do not restate, reinterpret, downgrade, or replace it in the checkpoint. Preserve only transient conversational and task state there.',
  ].filter(Boolean).join('\n')
}

/**
 * Replaces the deployment's coding-persona slot only for a session with an
 * explicit mission. It preserves the capability/tooling statement without
 * competing with the session's identity declaration.
 */
export function renderMissionCapabilityPersona(view: SessionMemoryView): string | undefined {
  if (view.document.relationship === null) return undefined
  return 'You operate through DeepSeek Harness and may use its coding, research, and system tools when useful. These are capabilities for carrying out the current session mission, not a replacement identity.'
}

/** Replace only DSH's deployment persona in a mission-bearing agent scope. */
export function applyMissionCapabilityPersona(
  assembly: PromptAssembly,
  view: SessionMemoryView,
): PromptAssembly {
  const capabilityPersona = renderMissionCapabilityPersona(view)
  if (capabilityPersona === undefined) return assembly
  return {
    ...assembly,
    sections: assembly.sections.map(section => section.name === 'deployment:persona'
      ? { ...section, text: capabilityPersona }
      : section),
  }
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
