/** DeepSeek-compatible auxiliary extraction and whole-state consolidation. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionMemoryActivity, SessionMemoryDocument, SessionMemoryItem, SessionMemorySection, SessionPerson } from './types.ts'

export const MAX_PEOPLE = 5
export const MAX_MEMORY_CARDS = 3
export const DEFAULT_PROFILE_CHARACTERS = 300

export const EXTRACTION_SYSTEM = [
  'Consolidate durable information from the newest direct message into the COMPLETE current session memory.',
  'Return JSON only with keys people, assistantRequirements, memories, atoms.',
  'people is a complete ordered array of at most 5 people. The first person usually corresponds to the current speaker,',
  'but never describe that person as the only user, owner, principal, or the whole world. Each person is',
  '{id,name,information,preference,relationship}. Keep an existing id when updating or renaming that person; omit id only',
  'for a genuinely new person. information and preference are each at most 300 Unicode characters. relationship describes',
  'that person’s current relationship and background with the active AI. A parent, friend, colleague, or another AI may be',
  'added when the direct message provides durable identifying information. Do not create people for organizations, products,',
  'or generic groups. Same-name people may coexist; never merge by name alone. Preserve every unaffected person and field.',
  'assistantRequirements is a complete array of at most 3 {category,text} cards containing explicit must, should, do-not,',
  'or stable interaction rules addressed to the AI. memories is a complete array of at most 3 {category,text} ordinary',
  'memories worth carrying forward; it is not a roleplay-only preset and has no enabled switch.',
  'A newer explicit correction may replace conflicting content. Do not invent facts or erase unrelated information.',
  'atoms is a compact audit list of actual durable updates: {text,disposition:"handled"|"skipped",section,reason}.',
  'section is people, assistantRequirements, memories, or null. Return [] when nothing durable changed. Emit JSON only.',
].join(' ')

interface ExtractionPerson { id?: string; name: string; information: string; preference: string; relationship: string }
interface ExtractionCard { category: string; text: string }
export interface ExtractionAtom { text: string; disposition: 'handled' | 'skipped'; section: SessionMemorySection | null; reason: string }
export interface ExtractionProposal {
  people: ExtractionPerson[]
  assistantRequirements: ExtractionCard[]
  memories: ExtractionCard[]
  atoms: ExtractionAtom[]
}

export interface OverwriteApproval {
  readonly section: SessionMemorySection
  readonly before: string
  readonly after: string | null
  readonly approved: boolean
  readonly reason: string
}

export const OVERWRITE_REVIEW_SYSTEM = [
  'Review proposed destructive changes to multi-person session memory. Return JSON only as',
  '{"decisions":[{"section":"...","before":"...","after":"..."|null,"approved":true|false,"reason":"..."}]}.',
  'Approve only when the newest direct evidence explicitly corrects, supersedes, withdraws, or removes the exact prior',
  'person/card. New detail must not erase unrelated information. Account for every supplied candidate exactly once.',
].join(' ')

function clean(value: unknown): string | undefined { return typeof value === 'string' ? value.trim() : undefined }

function parseCards(value: unknown): ExtractionCard[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MEMORY_CARDS) return undefined
  const result: ExtractionCard[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const row = item as Record<string, unknown>
    const category = clean(row['category'])
    const text = clean(row['text'])
    if (!category || !text) return undefined
    result.push({ category, text })
  }
  return result
}

function parsePeople(value: unknown): ExtractionPerson[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) return undefined
  const ids = new Set<string>()
  const result: ExtractionPerson[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const row = item as Record<string, unknown>
    const id = clean(row['id'])
    const name = clean(row['name'])
    const information = clean(row['information'])
    const preference = clean(row['preference'])
    const relationship = clean(row['relationship'])
    if (!name || information === undefined || preference === undefined || relationship === undefined) return undefined
    if ([...information].length > DEFAULT_PROFILE_CHARACTERS || [...preference].length > DEFAULT_PROFILE_CHARACTERS) return undefined
    if (id) { if (ids.has(id)) return undefined; ids.add(id) }
    result.push({ ...(id ? { id } : {}), name, information, preference, relationship })
  }
  return result
}

function parseAtoms(value: unknown): ExtractionAtom[] | undefined {
  if (!Array.isArray(value) || value.length > 24) return undefined
  const sections = new Set<SessionMemorySection>(['people', 'assistantRequirements', 'memories'])
  const result: ExtractionAtom[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const row = item as Record<string, unknown>
    const text = clean(row['text']); const reason = clean(row['reason']); const section = row['section']
    if (!text || !reason || (row['disposition'] !== 'handled' && row['disposition'] !== 'skipped')) return undefined
    if (section !== null && (typeof section !== 'string' || !sections.has(section as SessionMemorySection))) return undefined
    result.push({ text, reason, disposition: row['disposition'], section: section as SessionMemorySection | null })
  }
  return result
}

export function parseExtraction(text: string): ExtractionProposal | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>
    const people = parsePeople(row['people'])
    const assistantRequirements = parseCards(row['assistantRequirements'])
    const memories = parseCards(row['memories'])
    const atoms = parseAtoms(row['atoms'])
    return people && assistantRequirements && memories && atoms ? { people, assistantRequirements, memories, atoms } : undefined
  } catch { return undefined }
}

function overwriteKey(value: Pick<OverwriteApproval, 'section' | 'before' | 'after'>): string {
  return JSON.stringify([value.section, value.before, value.after])
}

export function parseOverwriteReview(text: string, candidates: readonly Pick<OverwriteApproval, 'section' | 'before' | 'after'>[]): OverwriteApproval[] | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const rows = (value as Record<string, unknown>)['decisions']
    if (!Array.isArray(rows) || rows.length !== candidates.length) return undefined
    const expected = new Set(candidates.map(overwriteKey))
    const sections = new Set<SessionMemorySection>(['people', 'assistantRequirements', 'memories'])
    const result: OverwriteApproval[] = []
    for (const item of rows) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
      const row = item as Record<string, unknown>
      const section = clean(row['section']); const before = clean(row['before']); const after = row['after'] === null ? null : clean(row['after']); const reason = clean(row['reason'])
      if (!section || !sections.has(section as SessionMemorySection) || before === undefined || after === undefined || !reason || typeof row['approved'] !== 'boolean') return undefined
      const decision: OverwriteApproval = { section: section as SessionMemorySection, before, after, reason, approved: row['approved'] }
      if (!expected.delete(overwriteKey(decision))) return undefined
      result.push(decision)
    }
    return expected.size === 0 ? result : undefined
  } catch { return undefined }
}

export async function reviewOverwrites(ctx: Context, agent: Agent, turn: number, current: SessionMemoryDocument, directEvidence: string, candidates: readonly Pick<OverwriteApproval, 'section' | 'before' | 'after'>[], maxTokens: number, signal: AbortSignal): Promise<OverwriteApproval[] | undefined> {
  if (candidates.length === 0) return []
  const route = agent.session.requestHeader()?.config
  if (!route) return undefined
  const { BlockAssembler, createUserMessage, deepFreeze } = await import('@deepseek-ai/dsh-llm')
  const assembler = new BlockAssembler()
  const request = deepFreeze({
    provider: route.provider, model: route.model,
    messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ turn, newestDirectEvidence: directEvidence, currentMemory: current, candidateOverwrites: candidates }) }], source: { kind: 'plugin', plugin: 'dsh-session-memory-governance' } })],
    system: OVERWRITE_REVIEW_SYSTEM, maxTokens: Math.min(Math.max(maxTokens, 1024), 1536), sessionId: agent.id, signal,
  })
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  return parseOverwriteReview(assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim(), candidates)
}

function normalized(value: string): string { return value.trim().toLocaleLowerCase().replaceAll(/\s+/g, ' ') }
function objectText(value: unknown): string | null { return value === null || value === undefined ? null : JSON.stringify(value) }
function operation(before: string | null, after: string | null): SessionMemoryActivity['operation'] {
  if (before === null) return 'append'
  if (after === null) return 'replace'
  return normalized(after).includes(normalized(before)) ? 'merge' : 'replace'
}
function activity(section: SessionMemorySection, before: string | null, after: string | null, sourceSeqs: readonly number[], time: number, reason: string, op = operation(before, after)): SessionMemoryActivity {
  return { id: `activity-${randomUUID()}`, sourceSeqs: [...sourceSeqs], operation: op, section, before, after, reason, at: time }
}
function decision(approvals: readonly OverwriteApproval[] | undefined, section: SessionMemorySection, before: string, after: string | null): OverwriteApproval | undefined {
  if (approvals === undefined) return { section, before, after, approved: true, reason: 'Initial provisional merge.' }
  return approvals.find(value => value.section === section && value.before === before && value.after === after)
}

function reconcileCards(section: 'assistantRequirements' | 'memories', current: readonly SessionMemoryItem[], proposed: readonly ExtractionCard[], evidenceSeqs: readonly number[], time: number, approvals: readonly OverwriteApproval[] | undefined): { items: SessionMemoryItem[]; changes: SessionMemoryActivity[] } {
  const remaining = [...current]
  const items: SessionMemoryItem[] = []
  const changes: SessionMemoryActivity[] = []
  for (const card of proposed) {
    const at = remaining.findIndex(item => normalized(item.category) === normalized(card.category))
    const previous = at >= 0 ? remaining.splice(at, 1)[0] : undefined
    const next: SessionMemoryItem = previous && normalized(previous.text) === normalized(card.text)
      ? previous : { id: previous?.id ?? `memory-${randomUUID()}`, category: card.category, text: card.text, source: 'extracted', evidenceSeqs: [...new Set([...(previous?.evidenceSeqs ?? []), ...evidenceSeqs])] }
    const before = objectText(previous); const after = objectText(next)
    if (before !== after) {
      const approved = before === null || decision(approvals, section, before, after)?.approved === true
      if (!approved) { items.push(previous!); changes.push(activity(section, before, after, evidenceSeqs, time, 'Preserved because overwrite review did not approve the change.', 'skip')); continue }
      changes.push(activity(section, before, after, evidenceSeqs, time, previous ? 'Updated from direct evidence.' : 'Added from direct evidence.'))
    }
    items.push(next)
  }
  for (const previous of remaining) {
    const before = objectText(previous)!
    const approved = decision(approvals, section, before, null)?.approved === true
    if (!approved) { items.push(previous); changes.push(activity(section, before, null, evidenceSeqs, time, 'Preserved because deletion review did not approve omission.', 'skip')) }
    else changes.push(activity(section, before, null, evidenceSeqs, time, 'Removed after explicit correction.'))
  }
  return { items: items.slice(0, MAX_MEMORY_CARDS), changes }
}

function reconcilePeople(current: readonly SessionPerson[], proposed: readonly ExtractionPerson[], evidenceSeqs: readonly number[], time: number, approvals: readonly OverwriteApproval[] | undefined): { people: SessionPerson[]; changes: SessionMemoryActivity[] } {
  const remaining = [...current]
  const people: SessionPerson[] = []
  const changes: SessionMemoryActivity[] = []
  for (const row of proposed.slice(0, MAX_PEOPLE)) {
    const at = row.id ? remaining.findIndex(person => person.id === row.id) : -1
    const previous = at >= 0 ? remaining.splice(at, 1)[0] : undefined
    const next: SessionPerson = previous && [previous.name, previous.information, previous.preference, previous.relationship].every((value, index) => normalized(value) === normalized([row.name, row.information, row.preference, row.relationship][index]!))
      ? previous : {
        id: previous?.id ?? `person-${randomUUID()}`, name: row.name, information: row.information,
        preference: row.preference, relationship: row.relationship, source: 'extracted',
        evidenceSeqs: [...new Set([...(previous?.evidenceSeqs ?? []), ...evidenceSeqs])], updatedAt: time,
      }
    const before = objectText(previous); const after = objectText(next)
    if (before !== after) {
      const approved = before === null || decision(approvals, 'people', before, after)?.approved === true
      if (!approved) { people.push(previous!); changes.push(activity('people', before, after, evidenceSeqs, time, 'Preserved because overwrite review did not approve the person change.', 'skip')); continue }
      changes.push(activity('people', before, after, evidenceSeqs, time, previous ? 'Updated a represented person from direct evidence.' : 'Added a represented person from direct evidence.'))
    }
    people.push(next)
  }
  for (const previous of remaining) {
    const before = objectText(previous)!
    if (decision(approvals, 'people', before, null)?.approved === true) changes.push(activity('people', before, null, evidenceSeqs, time, 'Removed after explicit correction.'))
    else { people.push(previous); changes.push(activity('people', before, null, evidenceSeqs, time, 'Preserved because deletion review did not approve omission.', 'skip')) }
  }
  return { people: people.slice(0, MAX_PEOPLE), changes }
}

export interface MergeExtractionResult { readonly document: SessionMemoryDocument; readonly changes: readonly SessionMemoryActivity[] }
export interface MergeExtractionOptions { readonly overwriteApprovals?: readonly OverwriteApproval[] }

export function mergeExtraction(document: SessionMemoryDocument, proposal: ExtractionProposal, evidenceSeqs: readonly number[], time: number, options: MergeExtractionOptions = {}): MergeExtractionResult {
  const approvals = options.overwriteApprovals
  const people = reconcilePeople(document.people, proposal.people, evidenceSeqs, time, approvals)
  const requirements = reconcileCards('assistantRequirements', document.assistantRequirements, proposal.assistantRequirements, evidenceSeqs, time, approvals)
  const memories = reconcileCards('memories', document.memories, proposal.memories, evidenceSeqs, time, approvals)
  const changes = [...people.changes, ...requirements.changes, ...memories.changes]
  const changed = changes.some(change => change.operation !== 'skip')
  for (const atom of proposal.atoms) {
    if (atom.disposition === 'skipped') changes.push(activity(atom.section ?? 'people', null, null, evidenceSeqs, time, atom.reason, 'skip'))
  }
  return {
    document: { version: 4, revision: changed ? document.revision + 1 : document.revision, people: people.people, assistantRequirements: requirements.items, memories: memories.items, updatedAt: changed ? time : document.updatedAt },
    changes,
  }
}

export function turnExtractionInput(events: readonly SessionEvent[], turn: number): { input: string; sourceSeqs: number[] } | undefined {
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return undefined
  const rows: string[] = []; const sourceSeqs: number[] = []
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/start' || (event.type === 'turn/end' && event.data.turn === turn)) break
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      rows.push(`DIRECT_MESSAGE:\n${event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')}`)
      sourceSeqs.push(event.seq)
    }
  }
  return sourceSeqs.length ? { input: rows.join('\n\n'), sourceSeqs } : undefined
}

export async function extractTurn(ctx: Context, agent: Agent, turn: number, current: SessionMemoryDocument, maxTokens: number, signal: AbortSignal): Promise<ExtractionProposal | undefined> {
  const input = turnExtractionInput(agent.session.events, turn)
  const route = agent.session.requestHeader()?.config
  if (!input || !route) return undefined
  const { BlockAssembler, createUserMessage, deepFreeze } = await import('@deepseek-ai/dsh-llm')
  const assembler = new BlockAssembler()
  const request = deepFreeze({
    provider: route.provider, model: route.model,
    messages: [createUserMessage({ content: [{ type: 'text', text: `${input.input}\n\nCURRENT_SESSION_MEMORY:\n${JSON.stringify(current)}` }], source: { kind: 'plugin', plugin: 'dsh-session-memory-governance' } })],
    system: EXTRACTION_SYSTEM, maxTokens, sessionId: agent.id, signal,
  })
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  return parseExtraction(assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim())
}
