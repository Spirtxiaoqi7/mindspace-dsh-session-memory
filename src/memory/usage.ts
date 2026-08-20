/** Capacity accounting for the user-editable session-memory document. */

import { Buffer } from 'node:buffer'
import type { SessionMemoryDocument } from './types.ts'

export const DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION = 0.2

export interface SessionMemoryUsageLimits {
  readonly maxTextBytes: number
  readonly maxItemsPerSection: number
  readonly maxProfileCharacters: number
}

/**
 * Measures only editable, persisted memory against this plugin's actual field
 * limits. System prompts, RAG, compaction summaries, evidence ids and event
 * history are deliberately excluded: none of them consumes the user's memory
 * document capacity.
 */
export function sessionMemoryUtilization(
  document: SessionMemoryDocument,
  limits: SessionMemoryUsageLimits,
): number {
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
  const used = bytes(document.userProfile.confirmed) + bytes(document.userProfile.inferred)
    + document.preferences.reduce((total, item) => total + bytes(item.category) + bytes(item.text), 0)
    + document.assistantInstructions.reduce((total, item) => total + bytes(item.category) + bytes(item.text), 0)
    + (document.relationship === null ? 0 : bytes(document.relationship.role) + bytes(document.relationship.mission) + bytes(document.relationship.guidance))
    + (document.roleplayPreset === null ? 0 : bytes(document.roleplayPreset.text))
  // Profile has a Unicode code-point limit rather than a byte limit. Four
  // bytes per code point is the safe UTF-8 ceiling used for this capacity view.
  const capacity = limits.maxProfileCharacters * 4
    + limits.maxItemsPerSection * limits.maxTextBytes * 4
    + limits.maxTextBytes * 4
  return capacity === 0 ? 1 : Math.min(1, used / capacity)
}
