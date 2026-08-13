/** Client-safe values for one session's editable personalization memory. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

/** Stable identity and text of one user-controlled memory entry. */
export interface SessionMemoryItem {
  readonly id: string
  readonly text: string
  readonly source: 'user' | 'extracted'
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

/** A summary read directly from DSH compaction or explicitly overridden. */
export interface SessionMemorySummary {
  readonly content: readonly ContentBlock[]
  readonly text: string
  readonly source: 'compaction' | 'user'
  readonly sourceSeq: number
}

/** Complete current memory state of one session. */
export interface SessionMemoryDocument {
  readonly version: 1
  readonly revision: number
  readonly summaryOverride: string | null
  readonly preferences: readonly SessionMemoryItem[]
  readonly userFacts: readonly SessionMemoryItem[]
  readonly assistantInstructions: readonly SessionMemoryItem[]
  readonly relationship: SessionRelationship | null
  readonly roleplayPreset: SessionRoleplayPreset | null
  readonly updatedAt: number
}

/** Read view combining the editable document with the latest DSH compaction. */
export interface SessionMemoryView {
  readonly document: SessionMemoryDocument
  /** Latest summary authored by DSH compaction, never hidden by an override. */
  readonly compactionSummary: SessionMemorySummary | null
  /** Effective summary: user override when present, otherwise compaction. */
  readonly summary: SessionMemorySummary | null
}

/** Compare-and-set replacement written by the personalization editor. */
export interface ReplaceSessionMemoryRequest {
  readonly expectedRevision: number
  readonly summaryOverride: string | null
  readonly preferences: readonly SessionMemoryItem[]
  readonly userFacts: readonly SessionMemoryItem[]
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
    /** Current per-session personalization memory, including the compaction summary. */
    'session-memory': SessionMemoryView
  }
}
