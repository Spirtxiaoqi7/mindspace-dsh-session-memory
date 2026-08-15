/** DeepSeek-compatible auxiliary extraction and whole-state memory consolidation. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SessionMemoryActivity,
  SessionMemoryDocument,
  SessionMemoryItem,
  SessionMemorySection,
  SessionRelationship,
  SessionRoleplayPreset,
  SessionUserProfile,
} from './types.ts'

export const MAX_MEMORY_CARDS = 3
export const DEFAULT_PROFILE_CHARACTERS = 300

export const EXTRACTION_SYSTEM = [
  'Session memory is important. Consolidate durable session-local personalization from the newest USER message into',
  'the COMPLETE current memory state. Return JSON only with keys userProfile, preferences, assistantInstructions,',
  'relationship, roleplayPreset. userProfile is {confirmed,inferred}: confirmed contains only user-stated identity,',
  'demographics, location, work, skills, life state, and durable habits; inferred contains cautious non-sensitive',
  'observations and must never be presented as fact. Keep their combined text near or below 300 Chinese characters.',
  'preferences and assistantInstructions are complete arrays of at most 3 {category,text} cards. A card is a compact',
  'structured category containing all related details. Merge new details into the best existing card; do not append a',
  'sentence-shaped card when a category can absorb it. A newer explicit correction replaces conflicting old content.',
  'For “not X but Y” corrections, remove X instead of preserving “does not use X” unless the user separately states',
  'that avoiding X is itself a durable preference.',
  'Preserve every unaffected current fact and card. relationship and roleplayPreset are the complete resulting object',
  'or null. An assistant name, nickname, self-designation, relationship-specific title, or how the user addresses the',
  'assistant belongs in relationship or roleplayPreset, never userProfile or preferences. Preserve existing preset',
  'content when adding an alias. Judge only user text: assistant refusal does not cancel user input. Never invent',
  'sensitive facts. The',
  'response is rejected atomically if incomplete or invalid. Also return atoms, one row for EVERY distinct claim in',
  'the newest user message: {text,disposition:"handled"|"skipped",section,reason}; handled requires a target section',
  'and skipped requires a concrete reason. This coverage ledger prevents partial writes.',
].join(' ')

export const DEFAULT_RELATIONSHIP_MISSION
  = 'Interact using the relationship explicitly assigned by the user in this session.'

interface ExtractionCard {
  category: string
  text: string
}

export interface ExtractionAtom {
  text: string
  disposition: 'handled' | 'skipped'
  section: SessionMemorySection | null
  reason: string
}

export interface ExtractionProposal {
  userProfile: Pick<SessionUserProfile, 'confirmed' | 'inferred'>
  preferences: ExtractionCard[]
  assistantInstructions: ExtractionCard[]
  relationship: SessionRelationship | null
  roleplayPreset: SessionRoleplayPreset | null
  atoms: ExtractionAtom[]
}

/** Add an assistant identity note without silently changing the user's preset switch. */
export function mergeAssistantIdentity(
  current: SessionRoleplayPreset | null,
  identity: string,
  enabled?: boolean,
): SessionRoleplayPreset {
  const note = identity.trim()
  const existing = current?.text.trim() ?? ''
  const text = existing.includes(note) ? existing : [existing, note].filter(Boolean).join('\n')
  return { enabled: enabled ?? current?.enabled ?? true, text }
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

function parseCards(value: unknown): ExtractionCard[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined
  const cards: ExtractionCard[] = []
  const categories = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const row = item as Record<string, unknown>
    const category = clean(row['category'])
    const text = clean(row['text'])
    if (category === undefined || category.length === 0 || text === undefined || text.length === 0) return undefined
    const key = category.toLocaleLowerCase()
    if (categories.has(key)) return undefined
    categories.add(key)
    cards.push({ category, text })
  }
  return cards
}

const SECTIONS = new Set<SessionMemorySection>([
  'userProfile', 'preferences', 'assistantInstructions', 'relationship', 'roleplayPreset',
])

function parseAtoms(value: unknown): ExtractionAtom[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined
  const atoms: ExtractionAtom[] = []
  for (const valueItem of value) {
    if (typeof valueItem !== 'object' || valueItem === null || Array.isArray(valueItem)) return undefined
    const row = valueItem as Record<string, unknown>
    const text = clean(row['text'])
    const reason = clean(row['reason'])
    const disposition = row['disposition']
    const section = row['section'] === null ? null : clean(row['section'])
    if (text === undefined || text.length === 0 || reason === undefined || reason.length === 0) return undefined
    if (disposition !== 'handled' && disposition !== 'skipped') return undefined
    if (section !== null && !SECTIONS.has(section as SessionMemorySection)) return undefined
    if (disposition === 'handled' && section === null) return undefined
    atoms.push({ text, reason, disposition, section: section as SessionMemorySection | null })
  }
  return atoms
}

function parseRelationship(value: unknown): SessionRelationship | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const role = clean(row['role'])
  const mission = clean(row['mission'])
  const guidance = clean(row['guidance'])
  if (role === undefined || role.length === 0 || mission === undefined || mission.length === 0 || guidance === undefined) {
    return undefined
  }
  return { role, mission, guidance }
}

function parseRoleplayPreset(value: unknown): SessionRoleplayPreset | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const text = clean(row['text'])
  if (typeof row['enabled'] !== 'boolean' || text === undefined || text.length === 0) return undefined
  return { enabled: row['enabled'], text }
}

/** Parse one strict, complete replacement proposal. Partial model output is rejected. */
export function parseExtraction(text: string): ExtractionProposal | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const profile = record['userProfile']
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
    const profileRecord = profile as Record<string, unknown>
    const confirmed = clean(profileRecord['confirmed'])
    const inferred = clean(profileRecord['inferred'])
    if (confirmed === undefined || inferred === undefined) return undefined
    if ([...`${confirmed}${inferred}`].length > DEFAULT_PROFILE_CHARACTERS) return undefined
    const preferences = parseCards(record['preferences'])
    const assistantInstructions = parseCards(record['assistantInstructions'])
    const relationship = parseRelationship(record['relationship'])
    const roleplayPreset = parseRoleplayPreset(record['roleplayPreset'])
    const atoms = parseAtoms(record['atoms'])
    if (preferences === undefined || assistantInstructions === undefined
      || relationship === undefined || roleplayPreset === undefined || atoms === undefined) return undefined
    return {
      userProfile: { confirmed, inferred },
      preferences,
      assistantInstructions,
      relationship,
      roleplayPreset,
      atoms,
    }
  } catch (_invalidJson) {
    return undefined
  }
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll(/\s+/g, ' ')
}

function cardText(card: Pick<SessionMemoryItem, 'category' | 'text'>): string {
  return `${card.category}：${card.text}`
}

function objectText(value: object | null): string | null {
  return value === null ? null : JSON.stringify(value)
}

function operation(before: string | null, after: string | null): SessionMemoryActivity['operation'] {
  if (before === null) return 'append'
  if (after === null) return 'replace'
  return normalized(after).includes(normalized(before)) ? 'merge' : 'replace'
}

function consolidateOverflow(cards: readonly ExtractionCard[]): ExtractionCard[] {
  const next = cards.slice(0, MAX_MEMORY_CARDS).map(card => ({ ...card }))
  for (const overflow of cards.slice(MAX_MEMORY_CARDS)) {
    let target = 0
    for (let index = 1; index < next.length; index += 1) {
      if ((next[index]?.text.length ?? Infinity) < (next[target]?.text.length ?? Infinity)) target = index
    }
    const current = next[target]
    if (current === undefined) break
    next[target] = {
      category: `${current.category} / ${overflow.category}`,
      text: `${current.text}；${overflow.category}：${overflow.text}`,
    }
  }
  return next
}

function activity(
  section: SessionMemoryActivity['section'],
  before: string | null,
  after: string | null,
  sourceSeqs: readonly number[],
  time: number,
  reason: string,
): SessionMemoryActivity {
  return {
    id: `activity-${randomUUID()}`,
    sourceSeqs: [...sourceSeqs],
    operation: operation(before, after),
    section,
    before,
    after,
    reason,
    at: time,
  }
}

function reconcileCards(
  section: 'preferences' | 'assistantInstructions',
  current: readonly SessionMemoryItem[],
  proposed: readonly ExtractionCard[],
  evidenceSeqs: readonly number[],
  time: number,
): { items: SessionMemoryItem[]; changes: SessionMemoryActivity[] } {
  const available = [...current]
  const items: SessionMemoryItem[] = []
  const changes: SessionMemoryActivity[] = []
  for (const card of consolidateOverflow(proposed)) {
    const at = available.findIndex(item => normalized(item.category) === normalized(card.category))
    const previous = at < 0 ? undefined : available.splice(at, 1)[0]
    const unchanged = previous !== undefined
      && normalized(previous.category) === normalized(card.category)
      && normalized(previous.text) === normalized(card.text)
    const next: SessionMemoryItem = unchanged
      ? previous
      : {
        id: previous?.id ?? `memory-${randomUUID()}`,
        category: card.category,
        text: card.text,
        source: 'extracted',
        evidenceSeqs: [...new Set([...(previous?.evidenceSeqs ?? []), ...evidenceSeqs])],
      }
    items.push(next)
    if (!unchanged) {
      changes.push(activity(
        section,
        previous === undefined ? null : cardText(previous),
        cardText(next),
        evidenceSeqs,
        time,
        previous === undefined
          ? 'Added a durable category from explicit user evidence.'
          : 'Consolidated the newest explicit user evidence into its existing category.',
      ))
    }
  }
  for (const removed of available) {
    changes.push(activity(
      section,
      cardText(removed),
      null,
      evidenceSeqs,
      time,
      'Removed or superseded while reconciling the complete categorized state.',
    ))
  }
  return { items, changes }
}

export interface MergeExtractionResult {
  readonly document: SessionMemoryDocument
  readonly changes: readonly SessionMemoryActivity[]
}

/** Atomically reconcile one complete proposal against current memory without model-supplied item ids. */
export function mergeExtraction(
  document: SessionMemoryDocument,
  proposal: ExtractionProposal,
  evidenceSeqs: readonly number[],
  time: number,
): MergeExtractionResult {
  const preferences = reconcileCards('preferences', document.preferences, proposal.preferences, evidenceSeqs, time)
  const instructions = reconcileCards(
    'assistantInstructions', document.assistantInstructions, proposal.assistantInstructions, evidenceSeqs, time,
  )
  const changes = [...preferences.changes, ...instructions.changes]
  const profileChanged = normalized(document.userProfile.confirmed) !== normalized(proposal.userProfile.confirmed)
    || normalized(document.userProfile.inferred) !== normalized(proposal.userProfile.inferred)
  const userProfile: SessionUserProfile = profileChanged
    ? {
      ...proposal.userProfile,
      evidenceSeqs: [...new Set([...document.userProfile.evidenceSeqs, ...evidenceSeqs])],
    }
    : document.userProfile
  if (profileChanged) {
    const before = document.userProfile.confirmed.length === 0 && document.userProfile.inferred.length === 0
      ? null
      : `已确认：${document.userProfile.confirmed}\n观察：${document.userProfile.inferred}`
    changes.unshift(activity(
      'userProfile',
      before,
      `已确认：${userProfile.confirmed}\n观察：${userProfile.inferred}`,
      evidenceSeqs,
      time,
      'Rewrote the compact profile from the complete current profile and newest user evidence.',
    ))
  }
  for (const [section, before, after] of [
    ['relationship', document.relationship, proposal.relationship],
    ['roleplayPreset', document.roleplayPreset, proposal.roleplayPreset],
  ] as const) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push(activity(
        section,
        objectText(before),
        objectText(after),
        evidenceSeqs,
        time,
        'Applied the newest explicit session assignment over the prior value.',
      ))
    }
  }
  const changed = changes.length > 0
  const changedSections = new Set(changes.map(change => change.section))
  for (const atom of proposal.atoms) {
    if (atom.disposition === 'skipped' || atom.section === null || !changedSections.has(atom.section)) {
      changes.push({
        id: `activity-${randomUUID()}`,
        sourceSeqs: [...evidenceSeqs],
        operation: 'skip',
        section: atom.section ?? 'userProfile',
        before: null,
        after: null,
        reason: atom.disposition === 'skipped' ? atom.reason : `Already represented: ${atom.reason}`,
        at: time,
      })
    }
  }
  return {
    document: {
      version: 2,
      revision: changed ? document.revision + 1 : document.revision,
      userProfile,
      preferences: preferences.items,
      assistantInstructions: instructions.items,
      relationship: proposal.relationship,
      roleplayPreset: proposal.roleplayPreset,
      updatedAt: changed ? time : document.updatedAt,
    },
    changes,
  }
}

/** Explicit user text committed within one turn; assistant output is never memory evidence. */
export function turnExtractionInput(
  events: readonly SessionEvent[],
  turn: number,
): { input: string; sourceSeqs: number[] } | undefined {
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return undefined
  const rows: string[] = []
  const sourceSeqs: number[] = []
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/start' || (event.type === 'turn/end' && event.data.turn === turn)) break
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      rows.push(`USER:\n${text}`)
      sourceSeqs.push(event.seq)
    }
  }
  return sourceSeqs.length === 0 ? undefined : { input: rows.join('\n\n'), sourceSeqs }
}

/** Run and durably log one auxiliary extraction request. */
export async function extractTurn(
  ctx: Context,
  agent: Agent,
  turn: number,
  current: SessionMemoryDocument,
  maxTokens: number,
  signal: AbortSignal,
): Promise<ExtractionProposal | undefined> {
  const { BlockAssembler, createUserMessage, deepFreeze } = await import('@deepseek-ai/dsh-llm')
  const input = turnExtractionInput(agent.session.events, turn)
  const route = agent.session.requestHeader()?.config
  if (input === undefined || route === undefined) return undefined
  const extractionInput = `${input.input}\n\nCURRENT_SESSION_MEMORY:\n${JSON.stringify(current)}`
  agent.session.append('session-memory/extraction-request', {
    version: 2,
    turn,
    provider: route.provider,
    model: route.model,
    system: EXTRACTION_SYSTEM,
    input: extractionInput,
    maxTokens,
    sourceSeqs: input.sourceSeqs,
  }, { ignorable: true })
  const assembler = new BlockAssembler()
  const messages = [createUserMessage({
    content: [{ type: 'text', text: extractionInput }],
    source: { kind: 'plugin', plugin: 'dsh-session-memory-governance' },
  })]
  const request = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system: EXTRACTION_SYSTEM,
    maxTokens,
    sessionId: agent.id,
    signal,
  })
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  const blocks = assembler.blocks()
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  const proposal = parseExtraction(text)
  agent.session.append('session-memory/extraction-result', {
    version: 2,
    turn,
    rawOutput: blocks,
    accepted: proposal !== undefined,
    sourceSeqs: input.sourceSeqs,
  }, { ignorable: true })
  return proposal
}
