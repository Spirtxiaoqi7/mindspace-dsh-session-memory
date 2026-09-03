/** Client-safe values for one session's task-conditioned memory. */

export type SessionMemoryMode = 'chat' | 'work'

export interface SessionPerson {
  readonly id: string
  readonly name: string
  readonly information: string
  readonly preference: string
  readonly relationship: string
  readonly source: 'user' | 'extracted'
  readonly evidenceSeqs: readonly number[]
  readonly updatedAt: number
}

export interface SessionMemoryItem {
  readonly id: string
  readonly category: string
  readonly text: string
  readonly source: 'user' | 'extracted'
  readonly evidenceSeqs: readonly number[]
}

/** One face of the same user and AI. Labels differ by mode; storage does not. */
export interface SessionModeMemory {
  readonly people: readonly SessionPerson[]
  readonly assistantSetting: string
  /** Chat: outfit/current appearance. Work: current work role/state. */
  readonly assistantState: string
  readonly assistantRequirements: readonly SessionMemoryItem[]
  readonly memories: readonly SessionMemoryItem[]
}

export interface BridgePendingWrite {
  readonly id: string
  readonly fromMode: SessionMemoryMode
  readonly targetMode: SessionMemoryMode
  readonly instruction: string
  readonly suggestedAction: 'add_person' | 'update_person' | 'remove_person' | 'upsert_item' | 'remove_item'
  readonly suggestedSection?: 'assistantRequirements' | 'memories'
  readonly sourceSeqs: readonly number[]
  readonly createdAt: number
}

export interface SessionMemoryBridge {
  /** Neutral hand-off only; never a second long-term memory. */
  readonly transitionNote: string
  readonly pendingWrites: readonly BridgePendingWrite[]
}

export type SessionMemorySection = 'people' | 'assistantSetting' | 'assistantState' | 'assistantRequirements' | 'memories' | 'bridge'

export interface SessionMemoryActivity {
  readonly id: string
  readonly sourceSeqs: readonly number[]
  readonly operation: 'append' | 'merge' | 'replace' | 'skip' | 'switch' | 'stage' | 'consume'
  readonly section: SessionMemorySection
  readonly mode: SessionMemoryMode | null
  readonly before: string | null
  readonly after: string | null
  readonly reason: string
  readonly at: number
}

export interface SessionMemoryDocument {
  readonly version: 5
  readonly revision: number
  readonly activeMode: SessionMemoryMode
  readonly modeSource: 'user' | 'model' | 'migration'
  readonly modeReason: string
  readonly chat: SessionModeMemory
  readonly work: SessionModeMemory
  readonly bridge: SessionMemoryBridge
  readonly updatedAt: number
}

export interface ContextCompactionPolicy {
  readonly enabled: boolean
  readonly thresholdRatio: number
  readonly retainTokens: number
  readonly maxTokens: number
  readonly updatedAt: number
}

export interface ContextCompactionStatus {
  readonly providerAvailable: boolean
  readonly provider: string
  readonly model: string
  readonly contextWindow: number | null
  readonly estimatedTokens: number
  readonly thresholdTokens: number | null
  readonly effectiveRetainTokens: number | null
  readonly utilizationRatio: number | null
  readonly state: 'disabled' | 'unavailable' | 'waiting' | 'due'
  readonly lastCompaction: {
    readonly kind: 'automatic' | 'manual'
    readonly status: 'completed' | 'failed' | 'running'
    readonly at: number
    readonly error: string
  } | null
}

export interface SessionMemoryView {
  readonly document: SessionMemoryDocument
  readonly memoryActivity: readonly SessionMemoryActivity[]
}

export interface ReplaceSessionMemoryRequest {
  readonly expectedRevision: number
  readonly activeMode: SessionMemoryMode
  readonly modeSource: 'user' | 'model' | 'migration'
  readonly modeReason: string
  readonly chat: SessionModeMemory
  readonly work: SessionModeMemory
  readonly bridge: SessionMemoryBridge
}

export interface SessionMemoryFailure {
  readonly code: 'stale-revision' | 'invalid-document' | 'text-too-large'
  readonly message: string
}

export type SessionMemoryMutationResult =
  | { readonly ok: true; readonly value: SessionMemoryView }
  | { readonly ok: false; readonly error: SessionMemoryFailure }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { 'session-memory': SessionMemoryView }
}
