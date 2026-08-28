/** Capacity accounting for the editable multi-person memory document. */

import { Buffer } from 'node:buffer'
import type { SessionMemoryDocument } from './types.ts'

export const DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION = 0.2

export interface SessionMemoryUsageLimits {
  readonly maxTextBytes: number
  readonly maxItemsPerSection: number
  readonly maxProfileCharacters: number
}

export function sessionMemoryUtilization(document: SessionMemoryDocument, limits: SessionMemoryUsageLimits): number {
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
  const used = document.people.reduce((total, person) => total
    + bytes(person.name) + bytes(person.information) + bytes(person.preference) + bytes(person.relationship), 0)
    + document.assistantRequirements.reduce((total, item) => total + bytes(item.category) + bytes(item.text), 0)
    + document.memories.reduce((total, item) => total + bytes(item.category) + bytes(item.text), 0)
  const capacity = 5 * limits.maxProfileCharacters * 8
    + limits.maxItemsPerSection * limits.maxTextBytes * 2
  return capacity === 0 ? 1 : Math.min(1, used / capacity)
}
