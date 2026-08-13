/** Durable session-memory event vocabulary. */

import type { SessionMemoryDocument } from './types.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

/** Whole post-change state carried by each accepted edit. */
export interface SessionMemoryChangeEventData {
  readonly version: 1
  readonly operation: 'replace'
  readonly document: SessionMemoryDocument
}

/** Reconstructable auxiliary request used for automatic memory extraction. */
export interface SessionMemoryExtractionRequestEventData {
  readonly version: 1
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
  readonly version: 1
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
