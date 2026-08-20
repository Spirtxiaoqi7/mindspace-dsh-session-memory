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
  'A proposed destructive overwrite receives a second evidence review, so preserve an old card whenever the newest',
  'user message merely adds detail instead of explicitly correcting or withdrawing it.',
  'For “not X but Y” corrections, remove X instead of preserving “does not use X” unless the user separately states',
  'that avoiding X is itself a durable preference.',
  'Preserve every unaffected current fact and card. relationship and roleplayPreset are the complete resulting object',
  'or null. An assistant name, nickname, self-designation, relationship-specific title, or how the user addresses the',
  'assistant belongs in relationship or roleplayPreset, never userProfile or preferences. Preserve existing preset',
  'content when adding an alias. Judge only user text: assistant refusal does not cancel user input. Never invent',
  'sensitive facts. The',
  'response is rejected atomically if incomplete or invalid. Return atoms as a compact audit list only for durable',
  'updates you actually propose: {text,disposition:"handled"|"skipped",section,reason}. Use [] when this turn has',
  'no durable memory update. Do not enumerate ordinary conversation claims, do not think aloud, and emit JSON only.',
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

/**
 * A second-pass decision for a destructive automatic mutation. The primary
 * extractor is still free to propose a replacement; this guard only decides
 * whether that exact replacement is justified by the newest user evidence.
 */
export interface OverwriteApproval {
  readonly section: SessionMemorySection
  readonly before: string
  readonly after: string | null
  readonly approved: boolean
  readonly reason: string
}

/** A compact, evidence-bound prompt used only after an automatic overwrite is proposed. */
export const OVERWRITE_REVIEW_SYSTEM = [
  'You are reviewing a proposed automatic update to session-local memory. Return JSON only as',
  '{"decisions":[{"section":"...","before":"...","after":"..."|null,"approved":true|false,"reason":"..."}]}.',
  'Review only the supplied candidates. Approve a replacement or removal only when the newest USER evidence',
  'explicitly corrects, supersedes, or withdraws the exact prior fact/rule. New detail that does not directly',
  'contradict the old value must be rejected here so the normal merge path preserves both facts. Never approve',
  'a deletion merely because a complete-state proposal omitted a card. Every candidate needs one concise decision',
  'and a reason that cites the supplied user evidence; do not infer intent from assistant text.',
].join(' ')

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
  if (!Array.isArray(value) || value.length > 64) return undefined
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

function overwriteKey(candidate: Pick<OverwriteApproval, 'section' | 'before' | 'after'>): string {
  return JSON.stringify([candidate.section, candidate.before, candidate.after])
}

/**
 * A review is valid only when it accounts for every exact proposed overwrite.
 * Missing or altered candidates intentionally fail closed so an unrelated model
 * answer cannot authorize deletion of durable user data.
 */
export function parseOverwriteReview(
  text: string,
  candidates: readonly Pick<OverwriteApproval, 'section' | 'before' | 'after'>[],
): OverwriteApproval[] | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const rows = (value as Record<string, unknown>)['decisions']
    if (!Array.isArray(rows) || rows.length !== candidates.length) return undefined
    const expected = new Set(candidates.map(overwriteKey))
    const decisions: OverwriteApproval[] = []
    for (const rowValue of rows) {
      if (typeof rowValue !== 'object' || rowValue === null || Array.isArray(rowValue)) return undefined
      const row = rowValue as Record<string, unknown>
      const section = clean(row['section'])
      const before = clean(row['before'])
      const after = row['after'] === null ? null : clean(row['after'])
      const reason = clean(row['reason'])
      if (section === undefined || !SECTIONS.has(section as SessionMemorySection)
        || before === undefined || after === undefined || reason === undefined || typeof row['approved'] !== 'boolean') {
        return undefined
      }
      const decision: OverwriteApproval = {
        section: section as SessionMemorySection,
        before,
        after,
        approved: row['approved'],
        reason,
      }
      const key = overwriteKey(decision)
      if (!expected.delete(key)) return undefined
      decisions.push(decision)
    }
    return expected.size === 0 ? decisions : undefined
  } catch (_invalidJson) {
    return undefined
  }
}

/**
 * Ask the model to justify only destructive automatic mutations. The caller
 * passes raw user evidence and the exact before/after values, so the reviewer
 * cannot treat an omitted complete-state card as permission to delete it.
 */
export async function reviewOverwrites(
  ctx: Context,
  agent: Agent,
  turn: number,
  current: SessionMemoryDocument,
  userEvidence: string,
  candidates: readonly Pick<OverwriteApproval, 'section' | 'before' | 'after'>[],
  maxTokens: number,
  signal: AbortSignal,
): Promise<OverwriteApproval[] | undefined> {
  if (candidates.length === 0) return []
  const route = agent.session.requestHeader()?.config
  if (route === undefined) return undefined
  const { BlockAssembler, createUserMessage, deepFreeze } = await import('@deepseek-ai/dsh-llm')
  const input = JSON.stringify({
    turn,
    newestUserEvidence: userEvidence,
    currentMemory: current,
    candidateOverwrites: candidates,
  })
  const assembler = new BlockAssembler()
  const request = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: input }],
      source: { kind: 'plugin', plugin: 'dsh-session-memory-governance' },
    })],
    system: OVERWRITE_REVIEW_SYSTEM,
    // This payload contains only a small diff. Reserve a bounded answer budget
    // so reviewing an overwrite never competes with normal response context.
    maxTokens: Math.min(Math.max(maxTokens, 1024), 1536),
    sessionId: agent.id,
    signal,
  })
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
  return parseOverwriteReview(text, candidates)
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

function skippedOverwrite(
  section: SessionMemorySection,
  sourceSeqs: readonly number[],
  time: number,
  reason: string,
): SessionMemoryActivity {
  return {
    id: `activity-${randomUUID()}`,
    sourceSeqs: [...sourceSeqs],
    operation: 'skip',
    section,
    before: null,
    after: null,
    reason,
    at: time,
  }
}

function overwriteDecision(
  approvals: readonly OverwriteApproval[] | undefined,
  section: SessionMemorySection,
  before: string,
  after: string | null,
): OverwriteApproval | undefined {
  if (approvals === undefined) return { section, before, after, approved: true, reason: 'No separate overwrite review was required.' }
  return approvals.find(candidate => candidate.section === section
    && candidate.before === before && candidate.after === after)
}

function reconcileCards(
  section: 'preferences' | 'assistantInstructions',
  current: readonly SessionMemoryItem[],
  proposed: readonly ExtractionCard[],
  evidenceSeqs: readonly number[],
  time: number,
  approvals: readonly OverwriteApproval[] | undefined,
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
    const before = previous === undefined ? null : cardText(previous)
    const after = cardText(next)
    const mutation = before === null ? 'append' : operation(before, after)
    if (before !== null && mutation === 'replace') {
      const decision = overwriteDecision(approvals, section, before, after)
      if (decision?.approved !== true) {
        items.push(previous)
        changes.push(skippedOverwrite(
          section,
          evidenceSeqs,
          time,
          `Preserved the existing card because overwrite review did not approve it: ${decision?.reason ?? 'missing decision.'}`,
        ))
        continue
      }
    }
    items.push(next)
    if (!unchanged) {
      changes.push(activity(
        section,
        before,
        after,
        evidenceSeqs,
        time,
        previous === undefined
          ? 'Added a durable category from explicit user evidence.'
          : mutation === 'replace'
            ? `Replaced the category after explicit overwrite review: ${overwriteDecision(approvals, section, before, after)?.reason ?? 'approved.'}`
            : 'Consolidated the newest explicit user evidence into its existing category.',
      ))
    }
  }
  for (const removed of available) {
    const before = cardText(removed)
    const decision = overwriteDecision(approvals, section, before, null)
    if (decision?.approved !== true) {
      items.push(removed)
      changes.push(skippedOverwrite(
        section,
        evidenceSeqs,
        time,
        `Preserved the omitted card because deletion review did not approve it: ${decision?.reason ?? 'missing decision.'}`,
      ))
      continue
    }
    changes.push(activity(
      section,
      before,
      null,
      evidenceSeqs,
      time,
      `Removed or superseded after explicit overwrite review: ${decision.reason}`,
    ))
  }
  return { items, changes }
}

export interface MergeExtractionResult {
  readonly document: SessionMemoryDocument
  readonly changes: readonly SessionMemoryActivity[]
}

export interface MergeExtractionOptions {
  /** When present, every destructive automatic change must have an approved exact decision. */
  readonly overwriteApprovals?: readonly OverwriteApproval[]
}

/** Atomically reconcile one complete proposal against current memory without model-supplied item ids. */
export function mergeExtraction(
  document: SessionMemoryDocument,
  proposal: ExtractionProposal,
  evidenceSeqs: readonly number[],
  time: number,
  options: MergeExtractionOptions = {},
): MergeExtractionResult {
  const approvals = options.overwriteApprovals
  const preferences = reconcileCards('preferences', document.preferences, proposal.preferences, evidenceSeqs, time, approvals)
  const instructions = reconcileCards(
    'assistantInstructions', document.assistantInstructions, proposal.assistantInstructions, evidenceSeqs, time, approvals,
  )
  const changes = [...preferences.changes, ...instructions.changes]
  const proposedProfileChanged = normalized(document.userProfile.confirmed) !== normalized(proposal.userProfile.confirmed)
    || normalized(document.userProfile.inferred) !== normalized(proposal.userProfile.inferred)
  const profileBefore = document.userProfile.confirmed.length === 0 && document.userProfile.inferred.length === 0
    ? null
    : `已确认：${document.userProfile.confirmed}\n观察：${document.userProfile.inferred}`
  const profileAfter = `已确认：${proposal.userProfile.confirmed}\n观察：${proposal.userProfile.inferred}`
  const profileApproval = profileBefore === null || !proposedProfileChanged
    ? undefined
    : overwriteDecision(approvals, 'userProfile', profileBefore, profileAfter)
  const profileChanged = proposedProfileChanged && (profileBefore === null || profileApproval?.approved === true)
  const userProfile: SessionUserProfile = profileChanged
    ? {
      ...proposal.userProfile,
      evidenceSeqs: [...new Set([...document.userProfile.evidenceSeqs, ...evidenceSeqs])],
    }
    : document.userProfile
  if (proposedProfileChanged && !profileChanged) {
    changes.unshift(skippedOverwrite(
      'userProfile',
      evidenceSeqs,
      time,
      `Preserved the profile because overwrite review did not approve it: ${profileApproval?.reason ?? 'missing decision.'}`,
    ))
  } else if (profileChanged) {
    changes.unshift(activity(
      'userProfile',
      profileBefore,
      profileAfter,
      evidenceSeqs,
      time,
      profileBefore === null
        ? 'Created the compact profile from explicit user evidence.'
        : `Rewrote the compact profile after explicit overwrite review: ${profileApproval?.reason ?? 'approved.'}`,
    ))
  }
  const nextRelationship = { value: proposal.relationship }
  const nextRoleplayPreset = { value: proposal.roleplayPreset }
  for (const [section, before, after] of [
    ['relationship', document.relationship, proposal.relationship],
    ['roleplayPreset', document.roleplayPreset, proposal.roleplayPreset],
  ] as const) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const beforeText = objectText(before)
      const afterText = objectText(after)
      const decision = beforeText === null ? undefined : overwriteDecision(approvals, section, beforeText, afterText)
      if (beforeText !== null && decision?.approved !== true) {
        if (section === 'relationship') nextRelationship.value = before
        else nextRoleplayPreset.value = before
        changes.push(skippedOverwrite(
          section,
          evidenceSeqs,
          time,
          `Preserved the existing assignment because overwrite review did not approve it: ${decision?.reason ?? 'missing decision.'}`,
        ))
        continue
      }
      changes.push(activity(
        section,
        beforeText,
        afterText,
        evidenceSeqs,
        time,
        beforeText === null
          ? 'Applied a new explicit session assignment.'
          : `Applied an explicit session assignment after overwrite review: ${decision?.reason ?? 'approved.'}`,
      ))
    }
  }
  // Audit-only skip records must not advance the document revision or turn a
  // rejected overwrite into an apparent mutation.
  const changed = changes.some(change => change.operation !== 'skip')
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
      relationship: nextRelationship.value,
      roleplayPreset: nextRoleplayPreset.value,
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
