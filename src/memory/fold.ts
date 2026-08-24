/** Pure replay fold for per-session personalization memory. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LegacySessionMemoryDocumentV1, LegacySessionMemoryDocumentV2 } from './domain.ts'
import type { ContextCompactionPolicy, SessionMemoryDocument, SessionMemoryItem, SessionMemoryView } from './types.ts'

export const DEFAULT_COMPACTION_POLICY: ContextCompactionPolicy = Object.freeze({
  enabled: true, thresholdRatio: 0.164, retainTokens: 64_000, maxTokens: 6_000, updatedAt: 0,
})

/**
 * Produce the exact plain-data shape used on the Typert Remote boundary.
 *
 * Early preview events did not all carry `updatedAt`.  They remain useful
 * historical settings, but must never make the read-only settings screen fail
 * its strict result validation.
 */
export function normalizeCompactionPolicy(value: unknown): ContextCompactionPolicy {
  const candidate = value !== null && typeof value === 'object'
    ? value as Partial<ContextCompactionPolicy>
    : {}
  const thresholdRatio = Number.isFinite(candidate.thresholdRatio)
    && candidate.thresholdRatio! >= 0.05 && candidate.thresholdRatio! <= 0.8
    ? candidate.thresholdRatio!
    : DEFAULT_COMPACTION_POLICY.thresholdRatio
  const retainTokens = Number.isInteger(candidate.retainTokens) && candidate.retainTokens! >= 4096
    ? candidate.retainTokens!
    : DEFAULT_COMPACTION_POLICY.retainTokens
  const maxTokens = Number.isInteger(candidate.maxTokens)
    && candidate.maxTokens! >= 512 && candidate.maxTokens! <= 8192
    ? candidate.maxTokens!
    : DEFAULT_COMPACTION_POLICY.maxTokens
  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_COMPACTION_POLICY.enabled,
    thresholdRatio,
    retainTokens,
    maxTokens,
    updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt! : 0,
  }
}

export interface SessionMemoryFoldState {
  document: SessionMemoryDocument
  memoryActivity: SessionMemoryView['memoryActivity']
  compactionPolicy: ContextCompactionPolicy
}

/** Empty state before a session has personalization edits. */
export function emptySessionMemory(): SessionMemoryDocument {
  return {
    version: 3,
    revision: 0,
    userProfile: { confirmed: '', pendingConfirmation: '', confirmedEvidenceSeqs: [], pendingEvidenceSeqs: [] },
    preferences: [],
    assistantRequirements: [],
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
      pendingConfirmation: document.userProfile.pendingConfirmation.trim(),
      confirmedEvidenceSeqs: [...new Set(document.userProfile.confirmedEvidenceSeqs)],
      pendingEvidenceSeqs: [...new Set(document.userProfile.pendingEvidenceSeqs)],
    },
    preferences: normalizeMemoryCards(document.preferences, '综合偏好'),
    assistantRequirements: normalizeMemoryCards(document.assistantRequirements, '对AI的要求'),
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
    version: 3,
    revision: document.revision,
    userProfile: {
      confirmed: facts.join('；'),
      pendingConfirmation: '',
      confirmedEvidenceSeqs: [...new Set(factEvidence)],
      pendingEvidenceSeqs: [],
    },
    preferences: migrateLegacyCards(document.preferences, '综合偏好'),
    assistantRequirements: migrateLegacyCards(document.assistantInstructions, '对AI的要求'),
    relationship: migrateRelationship(document.relationship, document.updatedAt),
    roleplayPreset: document.roleplayPreset ?? null,
    updatedAt: document.updatedAt,
  }
}

function migrateRelationship(
  relationship: LegacySessionMemoryDocumentV2['relationship'],
  updatedAt: number,
): SessionMemoryDocument['relationship'] {
  if (relationship === null) return null
  const history = relationship.mission.trim().length === 0
    ? relationship.guidance.trim()
    : [relationship.guidance.trim(), `历史上曾设定目标“${relationship.mission.trim()}”，仅作背景，不构成永久使命。`].filter(Boolean).join('；')
  return { status: relationship.role.trim(), context: history, updatedAt }
}

/** Migrate the v0.2 profile and permanent-mission relationship into v0.3 semantics. */
export function migrateV2Document(document: LegacySessionMemoryDocumentV2): SessionMemoryDocument {
  return normalizeSessionMemoryDocument({
    version: 3,
    revision: document.revision,
    userProfile: {
      confirmed: document.userProfile.confirmed,
      pendingConfirmation: document.userProfile.inferred,
      confirmedEvidenceSeqs: [...document.userProfile.evidenceSeqs],
      pendingEvidenceSeqs: [...document.userProfile.evidenceSeqs],
    },
    preferences: [...document.preferences],
    assistantRequirements: [...document.assistantInstructions],
    relationship: migrateRelationship(document.relationship, document.updatedAt),
    roleplayPreset: document.roleplayPreset,
    updatedAt: document.updatedAt,
  })
}

/** Initial replay state. */
export function emptySessionMemoryFoldState(): SessionMemoryFoldState {
  return { document: emptySessionMemory(), memoryActivity: [], compactionPolicy: DEFAULT_COMPACTION_POLICY }
}

/** Apply one relevant event without scanning prior history. */
export function applySessionMemoryEvent(state: SessionMemoryFoldState, event: SessionEvent): SessionMemoryFoldState {
  if ((event as { type: string }).type === 'mindspace-compaction/policy') {
    const value = (event as unknown as { data: unknown }).data
    const normalized = normalizeCompactionPolicy(value)
    if (value !== null && typeof value === 'object'
      && 'enabled' in value && 'thresholdRatio' in value && 'retainTokens' in value && 'maxTokens' in value) {
      return { ...state, compactionPolicy: normalized }
    }
  }
  if (event.type !== 'session-memory/change') return state
  if (event.data.version === 1) {
    return { ...state, document: migrateLegacyDocument(event.data.document as LegacySessionMemoryDocumentV1) }
  }
  if (event.data.version === 2) {
    return { ...state, document: migrateV2Document(event.data.document as LegacySessionMemoryDocumentV2) }
  }
  return {
    ...state,
    document: normalizeSessionMemoryDocument(event.data.document),
    memoryActivity: [...state.memoryActivity, ...event.data.changes],
  }
}

/** Public view of one internal fold state. */
export function sessionMemoryView(state: SessionMemoryFoldState): SessionMemoryView {
  return { document: state.document, memoryActivity: state.memoryActivity }
}

/** Read the policy without widening the established sessionMemory/get wire contract. */
export function foldCompactionPolicy(events: readonly SessionEvent[]): ContextCompactionPolicy {
  let state = emptySessionMemoryFoldState()
  for (const event of events) state = applySessionMemoryEvent(state, event)
  return normalizeCompactionPolicy(state.compactionPolicy)
}

/** Fold one log into its latest editable document and activity ledger. */
export function foldSessionMemory(events: readonly SessionEvent[]): SessionMemoryView {
  let state = emptySessionMemoryFoldState()
  for (const event of events) state = applySessionMemoryEvent(state, event)
  return sessionMemoryView(state)
}
