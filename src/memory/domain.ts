/** Durable session-memory event vocabulary and legacy schemas. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionMemoryActivity, SessionMemoryDocument, SessionMemoryItem, SessionPerson } from './types.ts'

export interface LegacySessionMemoryDocumentV4 {
  readonly version: 4
  readonly revision: number
  readonly people: readonly SessionPerson[]
  readonly assistantRequirements: readonly SessionMemoryItem[]
  readonly memories: readonly SessionMemoryItem[]
  readonly updatedAt: number
}

export interface LegacySessionRoleplayPreset { readonly enabled: boolean; readonly text: string }
export interface LegacySessionMemoryItem {
  readonly id: string
  readonly category: string
  readonly text: string
  readonly source: 'user' | 'extracted'
  readonly evidenceSeqs: readonly number[]
}

/** Shape persisted by v0.3 before people replaced the single-user profile. */
export interface LegacySessionMemoryDocumentV3 {
  readonly version: 3
  readonly revision: number
  readonly userProfile: {
    readonly confirmed: string
    readonly pendingConfirmation: string
    readonly confirmedEvidenceSeqs: readonly number[]
    readonly pendingEvidenceSeqs: readonly number[]
  }
  readonly preferences: readonly LegacySessionMemoryItem[]
  readonly assistantRequirements: readonly LegacySessionMemoryItem[]
  readonly relationship: null | { readonly status: string; readonly context: string; readonly updatedAt: number }
  readonly roleplayPreset: LegacySessionRoleplayPreset | null
  readonly updatedAt: number
}

export interface LegacySessionMemoryDocumentV2 {
  readonly version: 2
  readonly revision: number
  readonly userProfile: { readonly confirmed: string; readonly inferred: string; readonly evidenceSeqs: readonly number[] }
  readonly preferences: readonly LegacySessionMemoryItem[]
  readonly assistantInstructions: readonly LegacySessionMemoryItem[]
  readonly relationship: null | { readonly role: string; readonly mission: string; readonly guidance: string }
  readonly roleplayPreset: LegacySessionRoleplayPreset | null
  readonly updatedAt: number
}

export interface LegacySessionMemoryDocumentV1 {
  readonly version: 1
  readonly revision: number
  readonly summaryOverride: string | null
  readonly preferences: readonly LegacySessionMemoryItemV1[]
  readonly userFacts: readonly LegacySessionMemoryItemV1[]
  readonly assistantInstructions: readonly LegacySessionMemoryItemV1[]
  readonly relationship: null | { readonly role: string; readonly mission: string; readonly guidance: string }
  readonly roleplayPreset?: LegacySessionRoleplayPreset | null
  readonly updatedAt: number
}

export interface LegacySessionMemoryItemV1 {
  readonly id: string
  readonly text: string
  readonly source: 'user' | 'extracted'
  readonly evidenceSeqs: readonly number[]
}

export type SessionMemoryChangeEventData =
  | { readonly version: 1; readonly operation: 'replace'; readonly document: LegacySessionMemoryDocumentV1 }
  | { readonly version: 2; readonly operation: 'replace'; readonly document: LegacySessionMemoryDocumentV2; readonly changes: readonly SessionMemoryActivity[] }
  | { readonly version: 3; readonly operation: 'replace'; readonly document: LegacySessionMemoryDocumentV3; readonly changes: readonly SessionMemoryActivity[] }
  | { readonly version: 4; readonly operation: 'replace'; readonly document: LegacySessionMemoryDocumentV4; readonly changes: readonly SessionMemoryActivity[] }
  | { readonly version: 5; readonly operation: 'replace'; readonly document: SessionMemoryDocument; readonly changes: readonly SessionMemoryActivity[] }

export interface SessionMemoryExtractionRequestEventData {
  readonly version: 1 | 2 | 3 | 4 | 5
  readonly turn: number
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly input: string
  readonly maxTokens: number
  readonly sourceSeqs: readonly number[]
}

export interface SessionMemoryExtractionResultEventData {
  readonly version: 1 | 2 | 3 | 4 | 5
  readonly turn: number
  readonly rawOutput: ContentBlock[]
  readonly accepted: boolean
  readonly sourceSeqs: readonly number[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'session-memory/change': SessionMemoryChangeEventData
    'session-memory/extraction-request': SessionMemoryExtractionRequestEventData
    'session-memory/extraction-result': SessionMemoryExtractionResultEventData
  }
}
