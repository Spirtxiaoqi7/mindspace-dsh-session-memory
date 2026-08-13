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

function mergeCardText(current: string, incoming: string): string {
  const left = current.trim()
  const right = incoming.trim()
  if (left.length === 0) return right
  if (right.length === 0 || left.includes(right)) return left
  if (right.includes(left)) return right
  return `${left}；${right}`
}

/** Repair historical duplicate categories deterministically before any new mutation is validated. */
export function normalizeMemoryCards(
  items: readonly SessionMemoryItem[],
  fallbackCategory: string,
): SessionMemoryItem[] {
  const result: SessionMemoryItem[] = []
  const categoryIndexes = new Map<string, number>()
  for (const [index, item] of items.entries()) {
    const category = item.category.trim() || fallbackCategory
    const text = item.text.trim()
    if (text.length === 0) continue
    const key = category.toLocaleLowerCase()
    const duplicateAt = categoryIndexes.get(key)
    if (duplicateAt !== undefined) {
      const current = result[duplicateAt]!
      result[duplicateAt] = {
        ...current,
        text: mergeCardText(current.text, text),
        source: current.source === 'user' || item.source === 'user' ? 'user' : 'extracted',
        evidenceSeqs: [...new Set([...current.evidenceSeqs, ...item.evidenceSeqs])],
      }
      continue
    }
    categoryIndexes.set(key, result.length)
    result.push({
      ...item,
      id: item.id.trim() || `replayed-${fallbackCategory}-${index}`,
      category,
      text,
      evidenceSeqs: [...new Set(item.evidenceSeqs)],
    })
  }
  while (result.length > 3) {
    const overflow = result.pop()!
    const target = result[2]!
    result[2] = {
      ...target,
      category: `${target.category} / ${overflow.category}`,
      text: mergeCardText(target.text, `${overflow.category}：${overflow.text}`),
      source: target.source === 'user' || overflow.source === 'user' ? 'user' : 'extracted',
      evidenceSeqs: [...new Set([...target.evidenceSeqs, ...overflow.evidenceSeqs])],
    }
  }
  return result
}

/** Normalize persisted V2 documents so early preview builds cannot lock all later writes. */
export function normalizeSessionMemoryDocument(document: SessionMemoryDocument): SessionMemoryDocument {
  return {
    ...document,
    userProfile: {
      confirmed: document.userProfile.confirmed.trim(),
      inferred: document.userProfile.inferred.trim(),
      evidenceSeqs: [...new Set(document.userProfile.evidenceSeqs)],
    },
    preferences: normalizeMemoryCards(document.preferences, '综合偏好'),
    assistantInstructions: normalizeMemoryCards(document.assistantInstructions, '交互要求'),
  }
}

function migrateLegacyCards(
  items: LegacySessionMemoryDocumentV1['preferences'],
  category: string,
): SessionMemoryItem[] {
  return normalizeMemoryCards(items.map(item => legacyCard(item, category)), category)
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
    document: normalizeSessionMemoryDocument(event.data.document),
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
