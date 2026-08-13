/** Durable session-memory event vocabulary. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionMemoryActivity, SessionMemoryDocument } from './types.ts'

/** Shape persisted by v0.1. Kept solely so existing session logs replay. */
export interface LegacySessionMemoryDocumentV1 {
  readonly version: 1
  readonly revision: number
  readonly summaryOverride: string | null
  readonly preferences: readonly LegacySessionMemoryItemV1[]
  readonly userFacts: readonly LegacySessionMemoryItemV1[]
  readonly assistantInstructions: readonly LegacySessionMemoryItemV1[]
  readonly relationship: SessionMemoryDocument['relationship']
  readonly roleplayPreset?: SessionMemoryDocument['roleplayPreset']
  readonly updatedAt: number
}

export interface LegacySessionMemoryItemV1 {
  readonly id: string
  readonly text: string
  readonly source: 'user' | 'extracted'
  readonly evidenceSeqs: readonly number[]
}

/** Whole post-change state carried by each accepted edit. */
export type SessionMemoryChangeEventData =
  | {
    readonly version: 1
    readonly operation: 'replace'
    readonly document: LegacySessionMemoryDocumentV1
  }
  | {
    readonly version: 2
    readonly operation: 'replace'
    readonly document: SessionMemoryDocument
    readonly changes: readonly SessionMemoryActivity[]
  }

/** Reconstructable auxiliary request used for automatic memory extraction. */
export interface SessionMemoryExtractionRequestEventData {
  readonly version: 1 | 2
  readonly turn: number
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly input: string
  readonly maxTokens: number
  readonly sourceSeqs: readonly number[]
}

/** Complete model output accepted or rejected by the extraction parser. */
export interface SessionMemoryExtractionResultEventData {
  readonly version: 1 | 2
  readonly turn: number
  readonly rawOutput: ContentBlock[]
  readonly accepted: boolean
  readonly sourceSeqs: readonly number[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete post-edit personalization state for deterministic replay. */
    'session-memory/change': SessionMemoryChangeEventData
    /** Exact auxiliary extraction request, excluded from conversation history. */
    'session-memory/extraction-request': SessionMemoryExtractionRequestEventData
    /** Complete extraction output and parser disposition. */
    'session-memory/extraction-result': SessionMemoryExtractionResultEventData
  }
}
