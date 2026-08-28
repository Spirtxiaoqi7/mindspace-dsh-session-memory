/** Client-safe values for one session's editable multi-person memory. */

/** One person represented in the current conversation world. */
export interface SessionPerson {
  readonly id: string
  readonly name: string
  readonly information: string
  readonly preference: string
  /** This person's current relationship and background with the active AI. */
  readonly relationship: string
  readonly source: 'user' | 'extracted'
  readonly evidenceSeqs: readonly number[]
  readonly updatedAt: number
}

/** One categorized AI requirement or one ordinary memory group. */
export interface SessionMemoryItem {
  readonly id: string
  readonly category: string
  readonly text: string
  readonly source: 'user' | 'extracted'
  readonly evidenceSeqs: readonly number[]
}

export type SessionMemorySection = 'people' | 'assistantRequirements' | 'memories'

/** One inspectable state transition produced by a manual or automatic merge. */
export interface SessionMemoryActivity {
  readonly id: string
  readonly sourceSeqs: readonly number[]
  readonly operation: 'append' | 'merge' | 'replace' | 'skip'
  readonly section: SessionMemorySection
  readonly before: string | null
  readonly after: string | null
  readonly reason: string
  readonly at: number
}

/** Complete current memory state of one session. */
export interface SessionMemoryDocument {
  readonly version: 4
  readonly revision: number
  readonly people: readonly SessionPerson[]
  readonly assistantRequirements: readonly SessionMemoryItem[]
  readonly memories: readonly SessionMemoryItem[]
  readonly updatedAt: number
}

/** User-owned native context-compaction controls, isolated to one session. */
export interface ContextCompactionPolicy {
  readonly enabled: boolean
  readonly thresholdRatio: number
  readonly retainTokens: number
  readonly maxTokens: number
  readonly updatedAt: number
}

export interface SessionMemoryView {
  readonly document: SessionMemoryDocument
  readonly memoryActivity: readonly SessionMemoryActivity[]
}

export interface ReplaceSessionMemoryRequest {
  readonly expectedRevision: number
  readonly people: readonly SessionPerson[]
  readonly assistantRequirements: readonly SessionMemoryItem[]
  readonly memories: readonly SessionMemoryItem[]
}

export interface SessionMemoryFailure {
  readonly code: 'stale-revision' | 'invalid-document' | 'text-too-large'
  readonly message: string
}

export type SessionMemoryMutationResult =
  | { readonly ok: true; readonly value: SessionMemoryView }
  | { readonly ok: false; readonly error: SessionMemoryFailure }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'session-memory': SessionMemoryView
  }
}
