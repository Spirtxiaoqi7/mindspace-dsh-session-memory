/** Pure replay fold for per-session personalization memory. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LegacySessionMemoryDocumentV1 } from './domain.ts'
import type { SessionMemoryDocument, SessionMemoryItem, SessionMemoryView } from './types.ts'

export interface SessionMemoryFoldState {
  document: SessionMemoryDocument
  memoryActivity: SessionMemoryView['memoryActivity']
}

/** Empty state before a session has personalization edits. */
export function emptySessionMemory(): SessionMemoryDocument {
  return {
    version: 2,
    revision: 0,
    userProfile: { confirmed: '', inferred: '', evidenceSeqs: [] },
    preferences: [],
    assistantInstructions: [],
    relationship: null,
    roleplayPreset: null,
    updatedAt: 0,
  }
}

function legacyCard(item: LegacySessionMemoryDocumentV1['preferences'][number], category: string): SessionMemoryItem {
  return { ...item, category, evidenceSeqs: [...item.evidenceSeqs] }
}

function migrateLegacyCards(
  items: LegacySessionMemoryDocumentV1['preferences'],
  category: string,
): SessionMemoryItem[] {
  const result = items.slice(0, 3).map(item => legacyCard(item, category))
  for (const overflow of items.slice(3)) {
    const target = result[2]
    if (target === undefined) break
    result[2] = {
      ...target,
      text: `${target.text}；${overflow.text}`,
      evidenceSeqs: [...new Set([...target.evidenceSeqs, ...overflow.evidenceSeqs])],
    }
  }
  return result
}

/** Lossless-enough migration of the editable v0.1 state. Compaction overrides are deliberately retired. */
export function migrateLegacyDocument(document: LegacySessionMemoryDocumentV1): SessionMemoryDocument {
  const facts = document.userFacts.map(item => item.text.trim()).filter(Boolean)
  const factEvidence = document.userFacts.flatMap(item => item.evidenceSeqs)
  return {
    version: 2,
    revision: document.revision,
    userProfile: {
      confirmed: facts.join('；'),
      inferred: '',
      evidenceSeqs: [...new Set(factEvidence)],
    },
    preferences: migrateLegacyCards(document.preferences, '综合偏好'),
    assistantInstructions: migrateLegacyCards(document.assistantInstructions, '交互要求'),
    relationship: document.relationship,
    roleplayPreset: document.roleplayPreset ?? null,
    updatedAt: document.updatedAt,
  }
}

/** Initial replay state. */
export function emptySessionMemoryFoldState(): SessionMemoryFoldState {
  return { document: emptySessionMemory(), memoryActivity: [] }
}

/** Apply one relevant event without scanning prior history. */
export function applySessionMemoryEvent(state: SessionMemoryFoldState, event: SessionEvent): SessionMemoryFoldState {
  if (event.type !== 'session-memory/change') return state
  if (event.data.version === 1) {
    return { ...state, document: migrateLegacyDocument(event.data.document as LegacySessionMemoryDocumentV1) }
  }
  return {
    document: event.data.document,
    memoryActivity: [...state.memoryActivity, ...event.data.changes],
  }
}

/** Public view of one internal fold state. */
export function sessionMemoryView(state: SessionMemoryFoldState): SessionMemoryView {
  return { document: state.document, memoryActivity: state.memoryActivity }
}

/** Fold one log into its latest editable document and activity ledger. */
export function foldSessionMemory(events: readonly SessionEvent[]): SessionMemoryView {
  let state = emptySessionMemoryFoldState()
  for (const event of events) state = applySessionMemoryEvent(state, event)
  return sessionMemoryView(state)
}
