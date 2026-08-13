/** Pure replay fold for per-session personalization memory. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionMemoryDocument, SessionMemorySummary, SessionMemoryView } from './types.ts'

/** Internal state retains the compaction summary behind a user override. */
export interface SessionMemoryFoldState {
  document: SessionMemoryDocument
  compacted: SessionMemorySummary | null
}

/** Empty state before a session has personalization edits. */
export function emptySessionMemory(): SessionMemoryDocument {
  return {
    version: 1, revision: 0, summaryOverride: null, preferences: [], userFacts: [],
    assistantInstructions: [], relationship: null, roleplayPreset: null, updatedAt: 0,
  }
}

function normalizeDocument(document: SessionMemoryDocument): SessionMemoryDocument {
  // Sessions written by the first release predate roleplayPreset. Replay them
  // as disabled instead of invalidating durable logs.
  return { ...document, roleplayPreset: document.roleplayPreset ?? null }
}

/** Initial replay state. */
export function emptySessionMemoryFoldState(): SessionMemoryFoldState {
  return { document: emptySessionMemory(), compacted: null }
}

/** Apply one relevant event without scanning prior history. */
export function applySessionMemoryEvent(state: SessionMemoryFoldState, event: SessionEvent): SessionMemoryFoldState {
  if (event.type === 'session-memory/change') return { ...state, document: normalizeDocument(event.data.document) }
  if (event.type === 'compaction/summary') {
    const text = event.data.summary.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    if (text.length === 0) return state
    return { ...state, compacted: { content: event.data.summary, text, source: 'compaction', sourceSeq: event.seq } }
  }
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event) || !isCompactCheckpointSource(event.data.source)) return state
  const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  if (text.length === 0) return state
  return { ...state, compacted: { content: event.data.content, text, source: 'compaction', sourceSeq: event.seq } }
}

/** Public view of one internal fold state. */
export function sessionMemoryView(state: SessionMemoryFoldState): SessionMemoryView {
  const summary = state.document.summaryOverride === null
    ? state.compacted
    : {
      content: [{ type: 'text' as const, text: state.document.summaryOverride }],
      text: state.document.summaryOverride,
      source: 'user' as const,
      sourceSeq: state.document.revision,
    }
  return { document: state.document, compactionSummary: state.compacted, summary }
}

/** Fold one log into its latest editable document and DSH compaction summary. */
export function foldSessionMemory(events: readonly SessionEvent[]): SessionMemoryView {
  let state = emptySessionMemoryFoldState()
  for (const event of events) state = applySessionMemoryEvent(state, event)
  return sessionMemoryView(state)
}
