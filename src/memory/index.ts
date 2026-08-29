/** Event-sourced, editable personalization memory scoped to one DSH session. */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT } from '../generated/typert.host.js'
import { applySessionMemoryEvent, emptySessionMemoryFoldState, normalizeCompactionPolicy, sessionMemoryView } from './fold.ts'
import { installSessionCompactionPolicyBridge } from './compaction-bridge.ts'
import { SessionMemorySidecar } from './sidecar.ts'
import {
  DEFAULT_PROFILE_CHARACTERS,
  extractTurn,
  MAX_PEOPLE,
  MAX_MEMORY_CARDS,
  mergeExtraction,
  reviewOverwrites,
  turnExtractionInput,
} from './extraction.ts'
import { renderAssistantRequirements, renderSessionMemoryContext } from './render.ts'
import { DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION, sessionMemoryUtilization } from './usage.ts'
import type {
  ContextCompactionPolicy,
  ReplaceSessionMemoryRequest,
  SessionMemoryActivity,
  SessionMemoryDocument,
  SessionMemoryFailure,
  SessionMemoryItem,
  SessionPerson,
  SessionMemoryMutationResult,
  SessionMemorySection,
  SessionMemoryView,
} from './types.ts'

export type * from './types.ts'
export * from './domain.ts'
export {
  applySessionMemoryEvent,
  emptySessionMemory,
  emptySessionMemoryFoldState,
  foldSessionMemory,
  migrateLegacyDocument,
  sessionMemoryView,
} from './fold.ts'
export {
  DEFAULT_PROFILE_CHARACTERS,
  EXTRACTION_SYSTEM,
  MAX_MEMORY_CARDS,
  mergeExtraction,
  parseExtraction,
  parseOverwriteReview,
  reviewOverwrites,
  turnExtractionInput,
} from './extraction.ts'
export { renderAssistantRequirements, renderSessionMemory, renderSessionMemoryContext } from './render.ts'
export { DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION, sessionMemoryUtilization } from './usage.ts'
export type { SessionMemoryUsageLimits } from './usage.ts'

export interface Config {
  readonly maxTextBytes?: number
  /** Hard-capped at three even when a legacy config asks for more. */
  readonly maxItemsPerSection?: number
  /** Unicode code-point budget shared by confirmed and pending profile text. */
  readonly maxProfileCharacters?: number
  readonly autoExtract?: boolean
  /**
   * Background extraction is a cold-start fallback, not a second memory owner.
   * It runs only while the editable document is below this utilization ratio.
   */
  readonly autoExtractBelowUtilization?: number
  readonly extractionMaxTokens?: number
}

interface ResolvedConfig {
  readonly maxTextBytes: number
  readonly maxItemsPerSection: number
  readonly maxProfileCharacters: number
  readonly autoExtract: boolean
  readonly autoExtractBelowUtilization: number
  readonly extractionMaxTokens: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mindspaceSessionMemory: SessionMemoryService
  }
}

const memoryItemSchema = zod.object({
  id: zod.string(),
  category: zod.string(),
  text: zod.string(),
  source: zod.enum(['user', 'extracted']),
  evidenceSeqs: zod.array(zod.number()),
})
const personSchema = zod.object({
  id: zod.string(), name: zod.string(), information: zod.string(), preference: zod.string(), relationship: zod.string(),
  source: zod.enum(['user', 'extracted']), evidenceSeqs: zod.array(zod.number()), updatedAt: zod.number(),
})
const activitySchema = zod.object({
  id: zod.string(),
  sourceSeqs: zod.array(zod.number()),
  operation: zod.enum(['append', 'merge', 'replace', 'skip']),
  section: zod.enum(['people', 'assistantRequirements', 'memories']),
  before: zod.string().nullable(),
  after: zod.string().nullable(),
  reason: zod.string(),
  at: zod.number(),
})
const documentSchema = zod.object({
  version: zod.literal(4), revision: zod.number(), people: zod.array(personSchema),
  assistantRequirements: zod.array(memoryItemSchema), memories: zod.array(memoryItemSchema), updatedAt: zod.number(),
})
const viewSchema = zod.object({ document: documentSchema, memoryActivity: zod.array(activitySchema) })

const MEMORY_TOOL_GUIDANCE = [
  'Session memory represents multiple people in this conversation world. Before every write, call get_session_memory.',
  'The ordered people list contains at most five people. Person one corresponds to the current speaker, but is not the only',
  'person who may matter. Keep stable person ids; never merge people by name alone. For each person store a name, durable',
  'information, one concise preference, and that person’s current relationship/background with the active AI. Information',
  'and preference are each limited to 300 Unicode characters. assistantRequirements contains only explicit must, should,',
  'do-not, prohibition, or stable interaction rules addressed to the AI. memories contains up to three ordinary memory',
  'groups worth carrying forward; it is not a roleplay preset and has no enabled switch. Update the matching person/card',
  'instead of appending duplicates. Never invent people or facts. These tools affect only this session.',
].join(' ')

/** A model-owned memory write during this turn makes the cold-start fallback redundant. */
function turnAlreadyWroteSessionMemory(events: readonly SessionEvent[], turn: number): boolean {
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'turn/start' && event.data.turn === turn) { start = index; break }
  }
  return start >= 0 && events.slice(start + 1).some(event => event.type === 'session-memory/change')
}

function failure(code: SessionMemoryFailure['code'], message: string): SessionMemoryMutationResult {
  return { ok: false, error: { code, message } }
}

function validateText(value: string, field: string, maxBytes: number): SessionMemoryFailure | undefined {
  if (value.trim().length === 0) return { code: 'invalid-document', message: `${field} must not be blank` }
  const actual = Buffer.byteLength(value, 'utf8')
  return actual > maxBytes ? { code: 'text-too-large', message: `${field} is ${actual} bytes; limit is ${maxBytes}` } : undefined
}

function validateItems(
  items: readonly SessionMemoryItem[],
  field: string,
  config: ResolvedConfig,
): SessionMemoryFailure | undefined {
  if (items.length > config.maxItemsPerSection) {
    return { code: 'invalid-document', message: `${field} has ${items.length} cards; limit is ${config.maxItemsPerSection}` }
  }
  const ids = new Set<string>()
  const categories = new Set<string>()
  for (const [index, item] of items.entries()) {
    for (const [name, value] of [['id', item.id], ['category', item.category], ['text', item.text]] as const) {
      const invalid = validateText(value, `${field}[${index}].${name}`, config.maxTextBytes)
      if (invalid !== undefined) return invalid
    }
    if (ids.has(item.id)) return { code: 'invalid-document', message: `${field} repeats item id ${JSON.stringify(item.id)}` }
    ids.add(item.id)
    const category = item.category.trim().toLocaleLowerCase()
    if (categories.has(category)) return { code: 'invalid-document', message: `${field} repeats category ${JSON.stringify(item.category)}` }
    categories.add(category)
    if (item.evidenceSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) {
      return { code: 'invalid-document', message: `${field}[${index}] has an invalid evidence sequence` }
    }
  }
  return undefined
}

function resolveDocument(
  request: ReplaceSessionMemoryRequest,
  revision: number,
  time: number,
  config: ResolvedConfig,
): SessionMemoryDocument | SessionMemoryFailure {
  for (const [field, items] of [
    ['assistantRequirements', request.assistantRequirements], ['memories', request.memories],
  ] as const) {
    const invalid = validateItems(items, field, config)
    if (invalid !== undefined) return invalid
  }
  if (request.people.length > MAX_PEOPLE) return { code: 'invalid-document', message: `people has ${request.people.length} entries; limit is ${MAX_PEOPLE}` }
  const personIds = new Set<string>()
  for (const [index, person] of request.people.entries()) {
    for (const [field, value] of [['id', person.id], ['name', person.name]] as const) {
      const invalid = validateText(value, `people[${index}].${field}`, config.maxTextBytes)
      if (invalid !== undefined) return invalid
    }
    if (personIds.has(person.id)) return { code: 'invalid-document', message: `people repeats person id ${JSON.stringify(person.id)}` }
    personIds.add(person.id)
    for (const [field, value] of [['information', person.information], ['preference', person.preference], ['relationship', person.relationship]] as const) {
      if (Buffer.byteLength(value, 'utf8') > config.maxTextBytes) return { code: 'text-too-large', message: `people[${index}].${field} exceeds ${config.maxTextBytes} bytes` }
    }
    // Migrated V3 content is preserved even when it predates the 300-character rule.
    const isUnchangedLegacy = person.updatedAt <= 0
    if (!isUnchangedLegacy && [...person.information].length > config.maxProfileCharacters) return { code: 'text-too-large', message: `people[${index}].information exceeds ${config.maxProfileCharacters} characters` }
    if (!isUnchangedLegacy && [...person.preference].length > config.maxProfileCharacters) return { code: 'text-too-large', message: `people[${index}].preference exceeds ${config.maxProfileCharacters} characters` }
    if (person.evidenceSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) return { code: 'invalid-document', message: `people[${index}] has an invalid evidence sequence` }
  }
  return {
    version: 4,
    revision,
    people: request.people.map(person => ({ ...person, name: person.name.trim(), information: person.information.trim(), preference: person.preference.trim(), relationship: person.relationship.trim(), evidenceSeqs: [...person.evidenceSeqs] })),
    assistantRequirements: request.assistantRequirements.map(item => ({
      ...item, category: item.category.trim(), text: item.text.trim(), evidenceSeqs: [...item.evidenceSeqs],
    })),
    memories: request.memories.map(item => ({
      ...item, category: item.category.trim(), text: item.text.trim(), evidenceSeqs: [...item.evidenceSeqs],
    })),
    updatedAt: time,
  }
}

function displayPerson(person: SessionPerson | undefined): string | null {
  return person === undefined ? null : JSON.stringify(person)
}

function makeActivity(
  section: SessionMemorySection,
  before: string | null,
  after: string | null,
  time: number,
  sourceSeqs: readonly number[],
): SessionMemoryActivity {
  return {
    id: `activity-${randomUUID()}`,
    sourceSeqs: [...sourceSeqs],
    operation: before === null ? 'append' : after !== null && after.includes(before) ? 'merge' : 'replace',
    section,
    before,
    after,
    reason: sourceSeqs.length === 0
      ? '用户在记忆中心编辑了该记忆。'
      : '根据用户当前消息更新了该记忆。',
    at: time,
  }
}

function auditManualChange(
  current: SessionMemoryDocument,
  next: SessionMemoryDocument,
  time: number,
  sourceSeqs: readonly number[],
): SessionMemoryActivity[] {
  const changes: SessionMemoryActivity[] = []
  const personIds = new Set([...current.people.map(person => person.id), ...next.people.map(person => person.id)])
  for (const id of personIds) {
    const before = displayPerson(current.people.find(person => person.id === id))
    const after = displayPerson(next.people.find(person => person.id === id))
    if (before !== after) changes.push(makeActivity('people', before, after, time, sourceSeqs))
  }
  for (const section of ['assistantRequirements', 'memories'] as const) {
    const before = current[section]
    const after = next[section]
    const ids = new Set([...before.map(item => item.id), ...after.map(item => item.id)])
    for (const id of ids) {
      const oldItem = before.find(item => item.id === id)
      const newItem = after.find(item => item.id === id)
      const oldText = oldItem === undefined ? null : `${oldItem.category}：${oldItem.text}`
      const newText = newItem === undefined ? null : `${newItem.category}：${newItem.text}`
      if (oldText !== newText) changes.push(makeActivity(section, oldText, newText, time, sourceSeqs))
    }
  }
  return changes
}

export class SessionMemoryService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'typert']
  static Config: z<Config> = z.object({
    maxTextBytes: z.number().step(1).min(1).default(4096),
    maxItemsPerSection: z.number().step(1).min(1).max(MAX_MEMORY_CARDS).default(MAX_MEMORY_CARDS),
    maxProfileCharacters: z.number().step(1).min(1).default(DEFAULT_PROFILE_CHARACTERS),
    autoExtract: z.boolean().default(false),
    autoExtractBelowUtilization: z.number().min(0).max(1).default(DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION),
    extractionMaxTokens: z.number().step(1).min(1).default(6000),
  })

  private readonly resolved: ResolvedConfig
  private readonly installedAgents = new WeakSet<Agent>()
  private readonly modelReadState = new Map<string, { revision: number; turn: number }>()
  private readonly store = new SessionMemorySidecar()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mindspaceSessionMemory')
    // This package has hand-written strict descriptors rather than a generated
    // host-face export, so its one host service owns the one registration.
    ctx.typert.register(TYPERT)
    this.resolved = {
      maxTextBytes: config.maxTextBytes ?? 4096,
      maxItemsPerSection: Math.min(config.maxItemsPerSection ?? MAX_MEMORY_CARDS, MAX_MEMORY_CARDS),
      maxProfileCharacters: config.maxProfileCharacters ?? DEFAULT_PROFILE_CHARACTERS,
      autoExtract: config.autoExtract ?? false,
      autoExtractBelowUtilization: config.autoExtractBelowUtilization ?? DEFAULT_AUTO_EXTRACT_BELOW_UTILIZATION,
      extractionMaxTokens: config.extractionMaxTokens ?? 6000,
    }
    ctx.systemPrompt.section({ name: 'tool:session-memory', order: 113, text: MEMORY_TOOL_GUIDANCE })
    this.registerTools()
    installSessionCompactionPolicyBridge(ctx, agent => this.store.read(agent.session).compactionPolicy)
    ctx.inject(['systemPrompt'], (promptCtx) => {
      for (const agent of ctx.agents.roots()) this.installPrompt(agent)
      promptCtx.on('agent/created', ({ agent }) => { if (ctx.agents.roots().includes(agent)) this.installPrompt(agent) })
    })
    if (this.resolved.autoExtract) {
      ctx.inject(['llm'], (llmCtx) => {
        llmCtx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
          if (!ctx.agents.roots().includes(agent)) return
          try {
            const currentView = this.get(agent)
            const current = currentView.document
            if (sessionMemoryUtilization(current, this.resolved) >= this.resolved.autoExtractBelowUtilization) return
            if (turnAlreadyWroteSessionMemory(agent.session.events, turn)) return
            const proposal = await extractTurn(llmCtx, agent, turn, current, this.resolved.extractionMaxTokens, signal)
            if (proposal === undefined) return
            const sourceSeqs = turnExtractionInput(agent.session.events, turn)?.sourceSeqs ?? []
            const provisional = mergeExtraction(current, proposal, sourceSeqs, Date.now())
            const overwriteCandidates = provisional.changes
              .filter(change => change.operation === 'replace' && change.before !== null)
              .map(change => ({ section: change.section, before: change.before as string, after: change.after }))
            const userEvidence = turnExtractionInput(agent.session.events, turn)?.input
            // A full-state proposal may legitimately replace a durable fact, but
            // it must first pass a second, evidence-bound review. If the model
            // cannot produce that review we keep the old value and retain the
            // non-destructive append/merge work from the first proposal.
            const approvals = overwriteCandidates.length === 0
              ? undefined
              : await reviewOverwrites(
                llmCtx,
                agent,
                turn,
                current,
                userEvidence ?? '',
                overwriteCandidates,
                this.resolved.extractionMaxTokens,
                signal,
              )
            const merged = overwriteCandidates.length === 0
              ? provisional
              : mergeExtraction(current, proposal, sourceSeqs, Date.now(), { overwriteApprovals: approvals ?? [] })
            if (merged.changes.length === 0) return
            const validated = resolveDocument({
              expectedRevision: current.revision,
              people: merged.document.people,
              assistantRequirements: merged.document.assistantRequirements,
              memories: merged.document.memories,
            }, merged.document.revision, merged.document.updatedAt, this.resolved)
            if ('code' in validated) {
              ctx.logger.warn(`session-memory extraction rejected for session ${agent.id}: ${validated.message}`)
              return
            }
            this.store.replace(agent.session, {
              document: validated,
              memoryActivity: [...currentView.memoryActivity, ...merged.changes],
            })
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.warn(`session-memory extraction failed for session ${agent.id}: ${message}`)
          }
        })
      })
    }
  }

  @Remote('get')
  get(agent: Agent): SessionMemoryView {
    this.assertLive(agent)
    return this.store.read(agent.session).view
  }

  @Remote('replace')
  async replace(agent: Agent, request: ReplaceSessionMemoryRequest): Promise<SessionMemoryMutationResult> {
    return this.commit(agent, request, [])
  }

  /** Read the compaction policy separately from editable personalization data. */
  @Remote('getCompactionPolicy')
  getCompactionPolicy(agent: Agent): ContextCompactionPolicy {
    this.assertLive(agent)
    return normalizeCompactionPolicy(this.store.read(agent.session).compactionPolicy)
  }

  /** Persist one session's policy immediately without rewriting its memory document. */
  @Remote('setCompactionPolicy')
  async setCompactionPolicy(agent: Agent, policy: ContextCompactionPolicy): Promise<ContextCompactionPolicy> {
    this.assertLive(agent)
    if (!Number.isFinite(policy.thresholdRatio) || policy.thresholdRatio < 0.05 || policy.thresholdRatio > 0.8) {
      throw new Error('thresholdRatio must be between 0.05 and 0.8')
    }
    if (!Number.isInteger(policy.retainTokens) || policy.retainTokens < 4096) {
      throw new Error('retainTokens must be an integer >= 4096')
    }
    if (!Number.isInteger(policy.maxTokens) || policy.maxTokens < 512 || policy.maxTokens > 8192) {
      throw new Error('maxTokens must be an integer between 512 and 8192')
    }
    const next: ContextCompactionPolicy = { ...policy, updatedAt: Date.now() }
    return this.store.setPolicy(agent.session, next).compactionPolicy
  }

  private async commit(
    agent: Agent,
    request: ReplaceSessionMemoryRequest,
    sourceSeqs: readonly number[],
  ): Promise<SessionMemoryMutationResult> {
    this.assertLive(agent)
    const currentView = this.get(agent)
    const current = currentView.document
    if (request.expectedRevision !== current.revision) {
      return failure('stale-revision', `expected revision ${request.expectedRevision}; current revision is ${current.revision}`)
    }
    const time = Date.now()
    const resolved = resolveDocument(request, current.revision + 1, time, this.resolved)
    if ('code' in resolved) return { ok: false, error: resolved }
    const changes = auditManualChange(current, resolved, time, sourceSeqs)
    if (changes.length === 0) return { ok: true, value: currentView }
    const view: SessionMemoryView = {
      document: resolved,
      memoryActivity: [...currentView.memoryActivity, ...changes],
    }
    this.store.replace(agent.session, view)
    return { ok: true, value: view }
  }

  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`session-memory: agent ${agent.id} is not live`)
  }

  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'configure_context_compaction',
      description: 'Configure this conversation only: automatic context compaction starts at the chosen share of the routed model context window, preserves the newest tail, and writes a maximum-size editable checkpoint. Use this when the user asks to control context length or compaction. This is not personalization memory and does not alter profile, relationship, or roleplay.',
      parameters: {
        enabled: { type: 'boolean', required: true },
        threshold_percent: { type: 'number', description: '5 through 80. At this share of the model context window, automatic compaction begins.' },
        retain_tokens: { type: 'number', description: 'Newest raw context to preserve, at least 4096. Default 64000.' },
        summary_max_tokens: { type: 'number', description: 'Maximum checkpoint size, 512 through 8192. Default 6000.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec): Promise<JsonValue> => {
        if (exec.agent === undefined) throw new Error('configure_context_compaction requires an Agent-backed session')
        const percent = args.threshold_percent ?? 16.4
        const retainTokens = args.retain_tokens ?? 64_000
        const maxTokens = args.summary_max_tokens ?? 6_000
        if (!Number.isFinite(percent) || percent < 5 || percent > 80) throw new Error('threshold_percent must be between 5 and 80')
        if (!Number.isInteger(retainTokens) || retainTokens < 4096) throw new Error('retain_tokens must be an integer >= 4096')
        if (!Number.isInteger(maxTokens) || maxTokens < 512 || maxTokens > 8192) throw new Error('summary_max_tokens must be an integer between 512 and 8192')
        const policy = {
          version: 1 as const,
          enabled: args.enabled,
          thresholdRatio: percent / 100,
          retainTokens,
          maxTokens,
          updatedAt: Date.now(),
        }
        return (await this.setCompactionPolicy(exec.agent, policy)) as unknown as JsonValue
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'get_session_memory',
      description: 'Read the current ordered people, AI requirements, ordinary memories, and change activity for this session.',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (_args, exec): Promise<JsonValue> => {
        if (exec.agent === undefined) throw new Error('get_session_memory requires an Agent-backed session')
        const view = this.get(exec.agent)
        const turn = exec.agent.session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
        this.modelReadState.set(String(exec.agent.id), { revision: view.document.revision, turn })
        return Promise.resolve(view as unknown as JsonValue)
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'update_session_memory',
      description: 'Persist multi-person session memory after calling get_session_memory in this turn. Keep person ids stable; '
        + 'person one corresponds to the current speaker but is not the only represented person. Update existing entries instead of duplicating them.',
      parameters: {
        action: {
          type: 'string', required: true,
          enum: ['add_person', 'update_person', 'remove_person', 'upsert_item', 'remove_item'],
        },
        section: {
          type: 'string', enum: ['assistantRequirements', 'memories'],
          description: 'assistantRequirements = explicit rules for AI replies/actions; memories = ordinary remembered events or context.',
        },
        category: { type: 'string', description: 'Stable category used to merge a card without needing its item id.' },
        text: {
          type: 'string',
          description: 'Complete consolidated card/preset text, or one additive assistant identity note for remember_assistant_identity.',
        },
        item_id: { type: 'string', description: 'Optional exact card id for editing or removal.' },
        person_id: { type: 'string', description: 'Stable id returned by get_session_memory; required for update/remove.' },
        person_name: { type: 'string', description: 'Person name; required when adding and optional when updating.' },
        information: { type: 'string', description: 'Complete durable information for this person, up to 300 characters.' },
        preference: { type: 'string', description: 'One consolidated preference text for this person, up to 300 characters.' },
        relationship: { type: 'string', description: 'This person’s current relationship and background with the active AI.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec): Promise<JsonValue> => {
        if (exec.agent === undefined) throw new Error('update_session_memory requires an Agent-backed session')
        const current = this.get(exec.agent).document
        const turn = exec.agent.session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
        const readState = this.modelReadState.get(String(exec.agent.id))
        if (readState?.revision !== current.revision || readState.turn !== turn) {
          throw new Error('Call get_session_memory immediately before update_session_memory so the existing state can be classified and deduplicated.')
        }
        const latestUser = exec.agent.session.events.findLast(
          event => event.type === 'user/message' && event.data.source.kind === 'user',
        )
        const sourceSeqs = latestUser === undefined ? [] : [latestUser.seq]
        const request: ReplaceSessionMemoryRequest = {
          expectedRevision: current.revision,
          people: [...current.people],
          assistantRequirements: [...current.assistantRequirements],
          memories: [...current.memories],
        }
        if (args.action === 'add_person') {
          if (request.people.length >= MAX_PEOPLE) throw new Error(`people already has ${MAX_PEOPLE} entries`)
          if (!args.person_name?.trim()) throw new Error('person_name is required')
          Object.assign(request, { people: [...request.people, {
            id: `person-${randomUUID()}`, name: args.person_name, information: args.information ?? '',
            preference: args.preference ?? '', relationship: args.relationship ?? '', source: 'user',
            evidenceSeqs: [...sourceSeqs], updatedAt: Date.now(),
          } satisfies SessionPerson] })
        } else if (args.action === 'update_person' || args.action === 'remove_person') {
          if (!args.person_id) throw new Error('person_id is required')
          const people = [...request.people]
          const at = people.findIndex(person => person.id === args.person_id)
          if (at < 0) throw new Error(`person not found: ${args.person_id}`)
          if (args.action === 'remove_person') people.splice(at, 1)
          else {
            const previous = people[at]!
            people.splice(at, 1, { ...previous, name: args.person_name ?? previous.name,
              information: args.information ?? previous.information, preference: args.preference ?? previous.preference,
              relationship: args.relationship ?? previous.relationship, source: 'user',
              evidenceSeqs: [...new Set([...previous.evidenceSeqs, ...sourceSeqs])], updatedAt: Date.now() })
          }
          Object.assign(request, { people })
        } else if (args.action === 'upsert_item' || args.action === 'remove_item') {
          if (args.section === undefined) throw new Error('section is required for item actions')
          const entries = [...request[args.section]]
          const byId = args.item_id === undefined ? -1 : entries.findIndex(entry => entry.id === args.item_id)
          const byCategory = args.category === undefined
            ? -1
            : entries.findIndex(entry => entry.category.toLocaleLowerCase() === args.category?.trim().toLocaleLowerCase())
          const at = byId >= 0 ? byId : byCategory
          if (args.action === 'remove_item') {
            if (at < 0) throw new Error('item_id or matching category is required for remove_item')
            entries.splice(at, 1)
          } else {
            if (args.text === undefined || args.text.trim().length === 0) throw new Error('text is required for upsert_item')
            if (args.category === undefined || args.category.trim().length === 0) throw new Error('category is required')
            const next: SessionMemoryItem = {
              id: entries[at]?.id ?? `memory-${randomUUID()}`,
              category: args.category,
              text: args.text,
              source: 'user',
              evidenceSeqs: [...new Set([...(entries[at]?.evidenceSeqs ?? []), ...sourceSeqs])],
            }
            if (at >= 0) entries.splice(at, 1, next)
            else if (entries.length < MAX_MEMORY_CARDS) entries.push(next)
            else {
              const shortest = entries.reduce((best, item, index) => item.text.length < entries[best]!.text.length ? index : best, 0)
              const target = entries[shortest]!
              entries.splice(shortest, 1, {
                ...target,
                category: `${target.category} / ${next.category}`,
                text: `${target.text}；${next.category}：${next.text}`,
              })
            }
          }
          Object.assign(request, { [args.section]: entries })
        } else {
          throw new Error(`Unsupported memory action: ${String(args.action)}`)
        }
        const result = await this.commit(exec.agent, request, sourceSeqs)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        // One read authorizes one classified mutation only. A second write,
        // even in the same assistant step, must read the newly persisted state.
        this.modelReadState.delete(String(exec.agent.id))
        return result.value as unknown as JsonValue
      },
    }))
  }

  private installPrompt(agent: Agent): void {
    if (this.installedAgents.has(agent)) return
    this.installedAgents.add(agent)
    agent.ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      text: () => renderAssistantRequirements(this.get(agent)),
    })
    agent.ctx.systemPrompt.section({
      name: 'session-memory:personalization',
      order: 10,
      text: () => renderSessionMemoryContext(this.get(agent)),
    })
  }
}

export default SessionMemoryService

export type { Session }
