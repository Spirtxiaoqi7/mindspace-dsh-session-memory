/** Client-safe values for one session's editable personalization memory. */

/** Stable identity and compact, categorized text of one memory card. */
export interface SessionMemoryItem {
  readonly id: string
  readonly category: string
  readonly text: string
  readonly source: 'user' | 'extracted'
  readonly evidenceSeqs: readonly number[]
}

/** A compact user portrait. Confirmed facts and AI observations stay visibly distinct. */
export interface SessionUserProfile {
  readonly confirmed: string
  readonly inferred: string
  readonly evidenceSeqs: readonly number[]
}

/** Relationship identity and purpose assigned to one conversation window. */
export interface SessionRelationship {
  readonly role: string
  readonly mission: string
  readonly guidance: string
}

/** User-authored roleplay rules scoped to one conversation window. */
export interface SessionRoleplayPreset {
  readonly enabled: boolean
  readonly text: string
}

export type SessionMemorySection =
  | 'userProfile'
  | 'preferences'
  | 'assistantInstructions'
  | 'relationship'
  | 'roleplayPreset'

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
  readonly version: 2
  readonly revision: number
  readonly userProfile: SessionUserProfile
  readonly preferences: readonly SessionMemoryItem[]
  readonly assistantInstructions: readonly SessionMemoryItem[]
  readonly relationship: SessionRelationship | null
  readonly roleplayPreset: SessionRoleplayPreset | null
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

/** Public read view. DSH compaction remains an internal DSH concern. */
export interface SessionMemoryView {
  readonly document: SessionMemoryDocument
  readonly memoryActivity: readonly SessionMemoryActivity[]
}

/** Compare-and-set replacement written by the personalization editor. */
export interface ReplaceSessionMemoryRequest {
  readonly expectedRevision: number
  readonly userProfile: SessionUserProfile
  readonly preferences: readonly SessionMemoryItem[]
  readonly assistantInstructions: readonly SessionMemoryItem[]
  readonly relationship: SessionRelationship | null
  readonly roleplayPreset: SessionRoleplayPreset | null
}

/** Stable failure returned across the Remote boundary. */
export interface SessionMemoryFailure {
  readonly code: 'stale-revision' | 'invalid-document' | 'text-too-large'
  readonly message: string
}

/** Mutation result consumed by desktop and web editors. */
export type SessionMemoryMutationResult =
  | { readonly ok: true; readonly value: SessionMemoryView }
  | { readonly ok: false; readonly error: SessionMemoryFailure }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Current per-session personalization memory and its inspectable merge activity. */
    'session-memory': SessionMemoryView
  }
}
