/** Pure replay fold and lossless migrations for task-conditioned memory. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LegacySessionMemoryDocumentV1, LegacySessionMemoryDocumentV2, LegacySessionMemoryDocumentV3, LegacySessionMemoryDocumentV4, LegacySessionMemoryItem } from './domain.ts'
import type { ContextCompactionPolicy, SessionMemoryActivity, SessionMemoryDocument, SessionMemoryItem, SessionMemoryView, SessionModeMemory, SessionPerson } from './types.ts'

export const DEFAULT_COMPACTION_POLICY: ContextCompactionPolicy = Object.freeze({ enabled: true, thresholdRatio: 0.164, retainTokens: 64_000, maxTokens: 6_000, updatedAt: 0 })

export function normalizeCompactionPolicy(value: unknown): ContextCompactionPolicy {
  const candidate = value !== null && typeof value === 'object' ? value as Partial<ContextCompactionPolicy> : {}
  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_COMPACTION_POLICY.enabled,
    thresholdRatio: Number.isFinite(candidate.thresholdRatio) && candidate.thresholdRatio! >= 0.05 && candidate.thresholdRatio! <= 0.8 ? candidate.thresholdRatio! : DEFAULT_COMPACTION_POLICY.thresholdRatio,
    retainTokens: Number.isInteger(candidate.retainTokens) && candidate.retainTokens! >= 4096 ? candidate.retainTokens! : DEFAULT_COMPACTION_POLICY.retainTokens,
    maxTokens: Number.isInteger(candidate.maxTokens) && candidate.maxTokens! >= 512 && candidate.maxTokens! <= 8192 ? candidate.maxTokens! : DEFAULT_COMPACTION_POLICY.maxTokens,
    updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt! : 0,
  }
}

export interface SessionMemoryFoldState { document: SessionMemoryDocument; memoryActivity: SessionMemoryView['memoryActivity']; compactionPolicy: ContextCompactionPolicy }

export function emptyModeMemory(): SessionModeMemory {
  return { people: [], assistantSetting: '', assistantState: '', assistantRequirements: [], memories: [] }
}

export function emptySessionMemory(): SessionMemoryDocument {
  return { version: 5, revision: 0, activeMode: 'chat', modeSource: 'migration', modeReason: 'Initial mode', chat: emptyModeMemory(), work: emptyModeMemory(), bridge: { transitionNote: '', pendingWrites: [] }, updatedAt: 0 }
}

function mergeText(current: string, incoming: string): string {
  const left = current.trim(); const right = incoming.trim()
  if (!left) return right
  if (!right || left.includes(right)) return left
  if (right.includes(left)) return right
  return `${left}；${right}`
}

export function normalizeMemoryCards(items: readonly SessionMemoryItem[], fallbackCategory: string, limit = 3): SessionMemoryItem[] {
  const result: SessionMemoryItem[] = []; const categories = new Map<string, number>()
  for (const [index, item] of items.entries()) {
    const category = item.category.trim() || fallbackCategory; const text = item.text.trim()
    if (!text) continue
    const key = category.toLocaleLowerCase(); const duplicate = categories.get(key)
    if (duplicate !== undefined) {
      const current = result[duplicate]!
      result[duplicate] = { ...current, text: mergeText(current.text, text), source: current.source === 'user' || item.source === 'user' ? 'user' : 'extracted', evidenceSeqs: [...new Set([...current.evidenceSeqs, ...item.evidenceSeqs])] }
      continue
    }
    categories.set(key, result.length)
    result.push({ ...item, id: item.id.trim() || `replayed-${fallbackCategory}-${index}`, category, text, evidenceSeqs: [...new Set(item.evidenceSeqs)] })
  }
  while (result.length > limit) {
    const overflow = result.pop()!; const target = result[result.length - 1]!
    result[result.length - 1] = { ...target, category: `${target.category} / ${overflow.category}`, text: mergeText(target.text, `${overflow.category}：${overflow.text}`), evidenceSeqs: [...new Set([...target.evidenceSeqs, ...overflow.evidenceSeqs])] }
  }
  return result
}

function normalizePeople(people: readonly SessionPerson[]): SessionPerson[] {
  const result: SessionPerson[] = []; const ids = new Set<string>()
  for (const [index, person] of people.entries()) {
    const id = person.id.trim() || `person-${index + 1}`
    if (ids.has(id)) continue
    ids.add(id)
    result.push({ ...person, id, name: person.name.trim() || `人物${index + 1}`, information: person.information.trim(), preference: person.preference.trim(), relationship: person.relationship.trim(), evidenceSeqs: [...new Set(person.evidenceSeqs)], updatedAt: Number.isFinite(person.updatedAt) ? person.updatedAt : 0 })
    if (result.length === 5) break
  }
  return result
}

export function normalizeModeMemory(value: SessionModeMemory): SessionModeMemory {
  return { people: normalizePeople(value.people), assistantSetting: value.assistantSetting.trim(), assistantState: value.assistantState.trim(), assistantRequirements: normalizeMemoryCards(value.assistantRequirements, '对AI的要求'), memories: normalizeMemoryCards(value.memories, '记忆') }
}

export function normalizeSessionMemoryDocument(document: SessionMemoryDocument): SessionMemoryDocument {
  return { ...document, version: 5, modeReason: document.modeReason.trim(), chat: normalizeModeMemory(document.chat), work: normalizeModeMemory(document.work), bridge: { transitionNote: [...document.bridge.transitionNote.trim()].slice(0, 300).join(''), pendingWrites: document.bridge.pendingWrites.map(item => ({ ...item, instruction: item.instruction.trim(), sourceSeqs: [...new Set(item.sourceSeqs)] })).filter(item => item.instruction) } }
}

export function migrateV4Document(document: LegacySessionMemoryDocumentV4): SessionMemoryDocument {
  return normalizeSessionMemoryDocument({ version: 5, revision: document.revision, activeMode: 'chat', modeSource: 'migration', modeReason: 'Existing memory migrated to Chat', chat: { people: document.people, assistantSetting: '', assistantState: '', assistantRequirements: document.assistantRequirements, memories: document.memories }, work: emptyModeMemory(), bridge: { transitionNote: 'Existing session memory was preserved in Chat.', pendingWrites: [] }, updatedAt: document.updatedAt })
}

function legacyCard(item: { id: string; text: string; source: 'user' | 'extracted'; evidenceSeqs: readonly number[] }, category: string): SessionMemoryItem { return { ...item, category, evidenceSeqs: [...item.evidenceSeqs] } }
function legacyCards(items: readonly LegacySessionMemoryItem[], fallback: string): SessionMemoryItem[] { return normalizeMemoryCards(items.map(item => ({ ...item, evidenceSeqs: [...item.evidenceSeqs] })), fallback) }
function preferenceText(items: readonly LegacySessionMemoryItem[]): string { return items.map(item => `${item.category.trim() || '偏好'}：${item.text.trim()}`).filter(value => !value.endsWith('：')).join('；') }
function relationshipText(relationship: LegacySessionMemoryDocumentV3['relationship']): string { return relationship === null ? '' : [relationship.status.trim() ? `状态：${relationship.status.trim()}` : '', relationship.context.trim() ? `背景：${relationship.context.trim()}` : ''].filter(Boolean).join('；') }

export function migrateV3Document(document: LegacySessionMemoryDocumentV3): SessionMemoryDocument {
  const information = [document.userProfile.confirmed.trim(), document.userProfile.pendingConfirmation.trim()].filter(Boolean).join('；')
  const preference = preferenceText(document.preferences); const relationship = relationshipText(document.relationship)
  const evidenceSeqs = [...new Set([...document.userProfile.confirmedEvidenceSeqs, ...document.userProfile.pendingEvidenceSeqs, ...document.preferences.flatMap(item => item.evidenceSeqs)])]
  const people: SessionPerson[] = [information, preference, relationship].some(Boolean) ? [{ id: 'migrated-person-1', name: '人物一', information, preference, relationship, source: document.preferences.some(item => item.source === 'extracted') ? 'extracted' : 'user', evidenceSeqs, updatedAt: -1 }] : []
  const memories: SessionMemoryItem[] = document.roleplayPreset?.text.trim() ? [{ id: 'memory-migrated-roleplay', category: '既有记忆', text: document.roleplayPreset.text.trim(), source: 'user', evidenceSeqs: [] }] : []
  return migrateV4Document({ version: 4, revision: document.revision, people, assistantRequirements: legacyCards(document.assistantRequirements, '对AI的要求'), memories, updatedAt: document.updatedAt })
}

function v2Relationship(document: LegacySessionMemoryDocumentV2): LegacySessionMemoryDocumentV3['relationship'] {
  if (document.relationship === null) return null
  return { status: document.relationship.role.trim(), context: [document.relationship.guidance.trim(), document.relationship.mission.trim() ? `历史背景：${document.relationship.mission.trim()}` : ''].filter(Boolean).join('；'), updatedAt: document.updatedAt }
}

export function migrateV2Document(document: LegacySessionMemoryDocumentV2): SessionMemoryDocument {
  return migrateV3Document({ version: 3, revision: document.revision, userProfile: { confirmed: document.userProfile.confirmed, pendingConfirmation: document.userProfile.inferred, confirmedEvidenceSeqs: [...document.userProfile.evidenceSeqs], pendingEvidenceSeqs: [...document.userProfile.evidenceSeqs] }, preferences: document.preferences, assistantRequirements: document.assistantInstructions, relationship: v2Relationship(document), roleplayPreset: document.roleplayPreset, updatedAt: document.updatedAt })
}

export function migrateLegacyDocument(document: LegacySessionMemoryDocumentV1): SessionMemoryDocument {
  const facts = document.userFacts.map(item => item.text.trim()).filter(Boolean).join('；')
  return migrateV2Document({ version: 2, revision: document.revision, userProfile: { confirmed: facts, inferred: '', evidenceSeqs: [...new Set(document.userFacts.flatMap(item => item.evidenceSeqs))] }, preferences: document.preferences.map(item => legacyCard(item, '综合偏好')), assistantInstructions: document.assistantInstructions.map(item => legacyCard(item, '对AI的要求')), relationship: document.relationship, roleplayPreset: document.roleplayPreset ?? null, updatedAt: document.updatedAt })
}

function migrateActivity(activity: unknown): SessionMemoryActivity | undefined {
  if (activity === null || typeof activity !== 'object') return undefined
  const row = activity as Record<string, unknown>; const oldSection = String(row['section'] ?? '')
  const section: SessionMemoryActivity['section'] = oldSection === 'assistantRequirements' || oldSection === 'assistantInstructions' ? 'assistantRequirements' : oldSection === 'roleplayPreset' ? 'memories' : 'people'
  return { ...(row as unknown as SessionMemoryActivity), section, mode: (row['mode'] === 'chat' || row['mode'] === 'work') ? row['mode'] : 'chat' }
}

export function emptySessionMemoryFoldState(): SessionMemoryFoldState { return { document: emptySessionMemory(), memoryActivity: [], compactionPolicy: DEFAULT_COMPACTION_POLICY } }

export function applySessionMemoryEvent(state: SessionMemoryFoldState, event: SessionEvent): SessionMemoryFoldState {
  if ((event as { type: string }).type === 'mindspace-compaction/policy') {
    const value = (event as unknown as { data: unknown }).data
    if (value !== null && typeof value === 'object') return { ...state, compactionPolicy: normalizeCompactionPolicy(value) }
  }
  if (event.type !== 'session-memory/change') return state
  const version = event.data.version
  const document = version === 1 ? migrateLegacyDocument(event.data.document as LegacySessionMemoryDocumentV1) : version === 2 ? migrateV2Document(event.data.document as LegacySessionMemoryDocumentV2) : version === 3 ? migrateV3Document(event.data.document as LegacySessionMemoryDocumentV3) : version === 4 ? migrateV4Document(event.data.document as LegacySessionMemoryDocumentV4) : normalizeSessionMemoryDocument(event.data.document as SessionMemoryDocument)
  const changes = 'changes' in event.data ? event.data.changes.map(migrateActivity).filter((item): item is SessionMemoryActivity => item !== undefined) : []
  return { ...state, document, memoryActivity: [...state.memoryActivity, ...changes] }
}

export function sessionMemoryView(state: SessionMemoryFoldState): SessionMemoryView { return { document: state.document, memoryActivity: state.memoryActivity } }
export function foldCompactionPolicy(events: readonly SessionEvent[]): ContextCompactionPolicy { let state = emptySessionMemoryFoldState(); for (const event of events) state = applySessionMemoryEvent(state, event); return normalizeCompactionPolicy(state.compactionPolicy) }
export function foldSessionMemory(events: readonly SessionEvent[]): SessionMemoryView { let state = emptySessionMemoryFoldState(); for (const event of events) state = applySessionMemoryEvent(state, event); return sessionMemoryView(state) }
