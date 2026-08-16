/** Event-sourced, editable personalization memory scoped to one DSH session. */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT } from '../generated/typert.host.js'
import type { SessionMemoryFoldState } from './fold.ts'
import { applySessionMemoryEvent, emptySessionMemoryFoldState, foldCompactionPolicy, foldSessionMemory, normalizeCompactionPolicy, sessionMemoryView } from './fold.ts'
import {
  DEFAULT_PROFILE_CHARACTERS,
  DEFAULT_RELATIONSHIP_MISSION,
  extractTurn,
  MAX_MEMORY_CARDS,
  mergeAssistantIdentity,
  mergeExtraction,
} from './extraction.ts'
import { renderSessionMemory, renderSessionMissionIdentity } from './render.ts'
import type {
  ContextCompactionPolicy,
  ReplaceSessionMemoryRequest,
  SessionMemoryActivity,
  SessionMemoryDocument,
  SessionMemoryFailure,
  SessionMemoryItem,
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
  DEFAULT_RELATIONSHIP_MISSION,
  EXTRACTION_SYSTEM,
  MAX_MEMORY_CARDS,
  mergeExtraction,
  parseExtraction,
  turnExtractionInput,
} from './extraction.ts'
export { renderSessionMemory, renderSessionMissionIdentity } from './render.ts'

export interface Config {
  readonly maxTextBytes?: number
  /** Hard-capped at three even when a legacy config asks for more. */
  readonly maxItemsPerSection?: number
  /** Unicode code-point budget shared by confirmed and inferred profile text. */
  readonly maxProfileCharacters?: number
  readonly autoExtract?: boolean
  readonly extractionMaxTokens?: number
}

interface ResolvedConfig {
  readonly maxTextBytes: number
  readonly maxItemsPerSection: number
  readonly maxProfileCharacters: number
  readonly autoExtract: boolean
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
const userProfileSchema = zod.object({
  confirmed: zod.string(), inferred: zod.string(), evidenceSeqs: zod.array(zod.number()),
})
const relationshipSchema = zod.object({ role: zod.string(), mission: zod.string(), guidance: zod.string() })
const roleplayPresetSchema = zod.object({ enabled: zod.boolean(), text: zod.string() })
const activitySchema = zod.object({
  id: zod.string(),
  sourceSeqs: zod.array(zod.number()),
  operation: zod.enum(['append', 'merge', 'replace', 'skip']),
  section: zod.enum(['userProfile', 'preferences', 'assistantInstructions', 'relationship', 'roleplayPreset']),
  before: zod.string().nullable(),
  after: zod.string().nullable(),
  reason: zod.string(),
  at: zod.number(),
})
const documentSchema = zod.object({
  version: zod.literal(2), revision: zod.number(), userProfile: userProfileSchema,
  preferences: zod.array(memoryItemSchema), assistantInstructions: zod.array(memoryItemSchema),
  relationship: relationshipSchema.nullable(), roleplayPreset: roleplayPresetSchema.nullable(), updatedAt: zod.number(),
})
const viewSchema = zod.object({ document: documentSchema, memoryActivity: zod.array(activitySchema) })

const MEMORY_TOOL_GUIDANCE = [
  'Session memory is important durable user state. Call update_session_memory before replying whenever the user',
  'explicitly states or changes stable personal information, a preference, an assistant rule, relationship, identity,',
  'conversation purpose, or roleplay preset. The user does not need to say remember. Merge related preferences and',
  'assistant instructions into categorized cards; each section can contain at most three cards. New explicit facts',
  'replace conflicts. The personal profile separates confirmed user facts from cautious inferred observations.',
  'Taxonomy is strict: userProfile is only identity, demographics, location, work, skills, life state, and durable',
  'traits; preferences is what the user likes, dislikes, chooses, or habitually uses; assistantInstructions is how',
  'the assistant must answer or act. Never put answer-style rules in preferences, and never put likes/dislikes in',
  'userProfile. The assistant persona, name, nickname, self-designation, relationship-specific title, and how the user',
  'addresses the assistant belong in relationship or roleplayPreset, never userProfile or preferences. Use',
  'remember_assistant_identity for an additive assistant nickname or identity note. One message may require several',
  'update_session_memory calls so every section is updated.',
  'Never store an inference as confirmed or infer sensitive data. These tools affect only the current conversation.',
].join(' ')

const NEW_SESSION_ONBOARDING = [
  'This is the first turn of a session with no personalization yet. Address the user request first, then ask at most',
  'one short optional question about the role, purpose, or response style they want for this conversation. If the user',
  'already supplied any of those, do not ask again: persist the explicit setting with update_session_memory instead.',
].join(' ')

function isEmptyDocument(document: SessionMemoryDocument): boolean {
  return document.userProfile.confirmed.length === 0
    && document.userProfile.inferred.length === 0
    && document.preferences.length === 0
    && document.assistantInstructions.length === 0
    && document.relationship === null
    && document.roleplayPreset === null
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
    ['preferences', request.preferences], ['assistantInstructions', request.assistantInstructions],
  ] as const) {
    const invalid = validateItems(items, field, config)
    if (invalid !== undefined) return invalid
  }
  const profileCharacters = [...`${request.userProfile.confirmed}${request.userProfile.inferred}`].length
  if (profileCharacters > config.maxProfileCharacters) {
    return {
      code: 'text-too-large',
      message: `userProfile is ${profileCharacters} characters; limit is ${config.maxProfileCharacters}`,
    }
  }
  for (const [field, value] of [
    ['userProfile.confirmed', request.userProfile.confirmed],
    ['userProfile.inferred', request.userProfile.inferred],
  ] as const) {
    if (Buffer.byteLength(value, 'utf8') > config.maxTextBytes) {
      return { code: 'text-too-large', message: `${field} exceeds ${config.maxTextBytes} bytes` }
    }
  }
  if (request.userProfile.evidenceSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) {
    return { code: 'invalid-document', message: 'userProfile has an invalid evidence sequence' }
  }
  if (request.relationship !== null) {
    for (const field of ['role', 'mission'] as const) {
      const invalid = validateText(request.relationship[field], `relationship.${field}`, config.maxTextBytes)
      if (invalid !== undefined) return invalid
    }
    if (Buffer.byteLength(request.relationship.guidance, 'utf8') > config.maxTextBytes) {
      return { code: 'text-too-large', message: `relationship.guidance exceeds ${config.maxTextBytes} bytes` }
    }
  }
  if (request.roleplayPreset !== null) {
    if (request.roleplayPreset.enabled) {
      const invalid = validateText(request.roleplayPreset.text, 'roleplayPreset.text', config.maxTextBytes)
      if (invalid !== undefined) return invalid
    } else if (Buffer.byteLength(request.roleplayPreset.text, 'utf8') > config.maxTextBytes) {
      return { code: 'text-too-large', message: `roleplayPreset.text exceeds ${config.maxTextBytes} bytes` }
    }
  }
  return {
    version: 2,
    revision,
    userProfile: {
      confirmed: request.userProfile.confirmed.trim().replace(/^(?:已确认|确认信息)[:：]\s*/u, ''),
      inferred: request.userProfile.inferred.trim().replace(/^(?:AI\s*观察|观察)[:：]\s*/iu, ''),
      evidenceSeqs: [...request.userProfile.evidenceSeqs],
    },
    preferences: request.preferences.map(item => ({
      ...item, category: item.category.trim(), text: item.text.trim(), evidenceSeqs: [...item.evidenceSeqs],
    })),
    assistantInstructions: request.assistantInstructions.map(item => ({
      ...item, category: item.category.trim(), text: item.text.trim(), evidenceSeqs: [...item.evidenceSeqs],
    })),
    relationship: request.relationship === null ? null : {
      role: request.relationship.role.trim(),
      mission: request.relationship.mission.trim(),
      guidance: request.relationship.guidance.trim(),
    },
    roleplayPreset: request.roleplayPreset === null || request.roleplayPreset.text.trim().length === 0
      ? null
      : { enabled: request.roleplayPreset.enabled, text: request.roleplayPreset.text.trim() },
    updatedAt: time,
  }
}

function displayProfile(document: SessionMemoryDocument): string | null {
  const { confirmed, inferred } = document.userProfile
  return confirmed.length === 0 && inferred.length === 0 ? null : `已确认：${confirmed}\n观察：${inferred}`
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
  const beforeProfile = displayProfile(current)
  const afterProfile = displayProfile(next)
  if (beforeProfile !== afterProfile) changes.push(makeActivity('userProfile', beforeProfile, afterProfile, time, sourceSeqs))
  for (const section of ['preferences', 'assistantInstructions'] as const) {
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
  for (const section of ['relationship', 'roleplayPreset'] as const) {
    const before = current[section] === null ? null : JSON.stringify(current[section])
    const after = next[section] === null ? null : JSON.stringify(next[section])
    if (before !== after) changes.push(makeActivity(section, before, after, time, sourceSeqs))
  }
  return changes
}

export class SessionMemoryService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'typert']
  static Config: z<Config> = z.object({
    maxTextBytes: z.number().step(1).min(1).default(4096),
    maxItemsPerSection: z.number().step(1).min(1).max(MAX_MEMORY_CARDS).default(MAX_MEMORY_CARDS),
    maxProfileCharacters: z.number().step(1).min(1).default(DEFAULT_PROFILE_CHARACTERS),
    autoExtract: z.boolean().default(true),
    extractionMaxTokens: z.number().step(1).min(1).default(1536),
  })

  private readonly resolved: ResolvedConfig
  private readonly installedAgents = new WeakSet<Agent>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mindspaceSessionMemory')
    // This package has hand-written strict descriptors rather than a generated
    // host-face export, so its one host service owns the one registration.
    ctx.typert.register(TYPERT)
    this.resolved = {
      maxTextBytes: config.maxTextBytes ?? 4096,
      maxItemsPerSection: Math.min(config.maxItemsPerSection ?? MAX_MEMORY_CARDS, MAX_MEMORY_CARDS),
      maxProfileCharacters: config.maxProfileCharacters ?? DEFAULT_PROFILE_CHARACTERS,
      autoExtract: config.autoExtract ?? true,
      extractionMaxTokens: config.extractionMaxTokens ?? 1536,
    }
    ctx.systemPrompt.section({ name: 'tool:session-memory', order: 113, text: MEMORY_TOOL_GUIDANCE })
    this.registerTools()
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'session-memory', SessionMemoryFoldState>({
        key: 'session-memory', schema: viewSchema, init: emptySessionMemoryFoldState,
        apply: applySessionMemoryEvent, view: sessionMemoryView, stateVersion: 2,
      })
    })
    ctx.inject(['systemPrompt'], (promptCtx) => {
      for (const agent of ctx.agents.roots()) this.installPrompt(agent)
      promptCtx.on('agent/created', ({ agent }) => { if (ctx.agents.roots().includes(agent)) this.installPrompt(agent) })
    })
    if (this.resolved.autoExtract) {
      ctx.inject(['llm'], (llmCtx) => {
        llmCtx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
          if (!ctx.agents.roots().includes(agent)) return
          if (agent.session.events.some(
            event => event.type === 'session-memory/extraction-result' && event.data.turn === turn,
          )) return
          try {
            const current = foldSessionMemory(agent.session.events).document
            const proposal = await extractTurn(llmCtx, agent, turn, current, this.resolved.extractionMaxTokens, signal)
            if (proposal === undefined) return
            const result = agent.session.events.findLast(
              (event): event is SessionEvent<'session-memory/extraction-result'> =>
                event.type === 'session-memory/extraction-result' && event.data.turn === turn,
            )
            const merged = mergeExtraction(current, proposal, result?.data.sourceSeqs ?? [], Date.now())
            if (merged.changes.length === 0) return
            const validated = resolveDocument({
              expectedRevision: current.revision,
              userProfile: merged.document.userProfile,
              preferences: merged.document.preferences,
            assistantInstructions: merged.document.assistantInstructions,
            relationship: merged.document.relationship,
            roleplayPreset: merged.document.roleplayPreset,
            }, merged.document.revision, merged.document.updatedAt, this.resolved)
            if ('code' in validated) {
              ctx.logger.warn(`session-memory extraction rejected for session ${agent.id}: ${validated.message}`)
              return
            }
            agent.session.append('session-memory/change', {
              version: 2, operation: 'replace', document: validated, changes: merged.changes,
            }, { ignorable: true })
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
    return foldSessionMemory(agent.session.events)
  }

  @Remote('replace')
  async replace(agent: Agent, request: ReplaceSessionMemoryRequest): Promise<SessionMemoryMutationResult> {
    return this.commit(agent, request, [])
  }

  /** Read the compaction policy separately from editable personalization data. */
  @Remote('getCompactionPolicy')
  getCompactionPolicy(agent: Agent): ContextCompactionPolicy {
    this.assertLive(agent)
    // Always return a fresh JSON-safe, complete object for the strict Remote codec.
    return normalizeCompactionPolicy(foldCompactionPolicy(agent.session.events))
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
    agent.session.append('mindspace-compaction/policy' as never, { version: 1, ...next } as never, { ignorable: true })
    await this.ctx.sessions.flush(agent.session)
    return next
  }

  private async commit(
    agent: Agent,
    request: ReplaceSessionMemoryRequest,
    sourceSeqs: readonly number[],
  ): Promise<SessionMemoryMutationResult> {
    this.assertLive(agent)
    const current = foldSessionMemory(agent.session.events).document
    if (request.expectedRevision !== current.revision) {
      return failure('stale-revision', `expected revision ${request.expectedRevision}; current revision is ${current.revision}`)
    }
    const time = Date.now()
    const resolved = resolveDocument(request, current.revision + 1, time, this.resolved)
    if ('code' in resolved) return { ok: false, error: resolved }
    const changes = auditManualChange(current, resolved, time, sourceSeqs)
    if (changes.length === 0) return { ok: true, value: foldSessionMemory(agent.session.events) }
    if (changes.length > 0) {
      agent.session.append('session-memory/change', { version: 2, operation: 'replace', document: resolved, changes }, { ignorable: true })
    }
    await this.ctx.sessions.flush(agent.session)
    return { ok: true, value: foldSessionMemory(agent.session.events) }
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
      execute: (args, exec): JsonValue => {
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
        exec.agent.session.append('mindspace-compaction/policy' as never, policy as never, { ignorable: true })
        return policy as unknown as JsonValue
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'get_session_memory',
      description: 'Read the current compact profile, categorized cards, relationship, preset, and change activity.',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (_args, exec): Promise<JsonValue> => {
        if (exec.agent === undefined) throw new Error('get_session_memory requires an Agent-backed session')
        return Promise.resolve(this.get(exec.agent) as unknown as JsonValue)
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'update_session_memory',
      description: 'Persist explicit personalization now. Match item cards by category; exact item ids are optional. '
        + 'Merge related details and replace conflicts instead of creating sentence-shaped duplicate cards. '
        + 'Use userProfile only for identity/location/work/skills/life state; preferences for likes/dislikes/choices; '
        + 'assistantInstructions for rules governing assistant answers and behavior. Assistant names, nicknames, '
        + 'self-designations, and relationship-specific titles belong in relationship/roleplay memory; use '
        + 'remember_assistant_identity for an additive identity note and never put it in userProfile or preferences.',
      parameters: {
        action: {
          type: 'string', required: true,
          enum: [
            'set_user_profile', 'upsert_item', 'remove_item', 'set_relationship', 'clear_relationship',
            'remember_assistant_identity', 'set_roleplay_preset', 'clear_roleplay_preset',
          ],
        },
        section: {
          type: 'string', enum: ['preferences', 'assistantInstructions'],
          description: 'preferences = user likes/dislikes/choices; assistantInstructions = rules for AI replies/actions.',
        },
        category: { type: 'string', description: 'Stable category used to merge a card without needing its item id.' },
        text: {
          type: 'string',
          description: 'Complete consolidated card/preset text, or one additive assistant identity note for remember_assistant_identity.',
        },
        item_id: { type: 'string', description: 'Optional exact card id for editing or removal.' },
        confirmed: {
          type: 'string',
          description: 'Complete confirmed identity/location/work/skills/life-state profile; exclude preferences and AI rules.',
        },
        inferred: {
          type: 'string',
          description: 'Complete cautious inferred traits; exclude likes/dislikes and rules for AI replies.',
        },
        role: { type: 'string' },
        mission: { type: 'string' },
        guidance: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec): Promise<JsonValue> => {
        if (exec.agent === undefined) throw new Error('update_session_memory requires an Agent-backed session')
        const current = this.get(exec.agent).document
        const latestUser = exec.agent.session.events.findLast(
          event => event.type === 'user/message' && event.data.source.kind === 'user',
        )
        const sourceSeqs = latestUser === undefined ? [] : [latestUser.seq]
        const request: ReplaceSessionMemoryRequest = {
          expectedRevision: current.revision,
          userProfile: current.userProfile,
          preferences: [...current.preferences],
          assistantInstructions: [...current.assistantInstructions],
          relationship: current.relationship,
          roleplayPreset: current.roleplayPreset,
        }
        if (args.action === 'set_user_profile') {
          Object.assign(request, {
            userProfile: {
              confirmed: args.confirmed ?? current.userProfile.confirmed,
              inferred: args.inferred ?? current.userProfile.inferred,
              evidenceSeqs: [...new Set([...current.userProfile.evidenceSeqs, ...sourceSeqs])],
            },
          })
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
        } else if (args.action === 'set_relationship') {
          if (args.role === undefined || args.role.trim().length === 0) throw new Error('role is required')
          Object.assign(request, {
            relationship: {
              role: args.role,
              mission: args.mission ?? current.relationship?.mission ?? DEFAULT_RELATIONSHIP_MISSION,
              guidance: args.guidance ?? '',
            },
          })
        } else if (args.action === 'clear_relationship') {
          Object.assign(request, { relationship: null })
        } else if (args.action === 'remember_assistant_identity') {
          if (args.text === undefined || args.text.trim().length === 0) throw new Error('text is required')
          Object.assign(request, {
            roleplayPreset: mergeAssistantIdentity(current.roleplayPreset, args.text, args.enabled),
          })
        } else if (args.action === 'set_roleplay_preset') {
          if (args.text === undefined || args.text.trim().length === 0) throw new Error('text is required')
          Object.assign(request, { roleplayPreset: { enabled: args.enabled ?? true, text: args.text } })
        } else {
          Object.assign(request, { roleplayPreset: null })
        }
        const result = await this.commit(exec.agent, request, sourceSeqs)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value as unknown as JsonValue
      },
    }))
  }

  private installPrompt(agent: Agent): void {
    if (this.installedAgents.has(agent)) return
    this.installedAgents.add(agent)
    // Shadow only the agent-scoped identity slot. Do not use `complete`, which
    // would discard Harness Web, tool, and safety sections from the request.
    agent.ctx.systemPrompt.section({
      name: 'harness:identity',
      order: -100,
      text: () => renderSessionMissionIdentity(foldSessionMemory(agent.session.events))
        ?? 'You are an AI agent powered by DeepSeek Harness.',
    })
    agent.ctx.systemPrompt.section({
      name: 'session-memory:personalization',
      order: 10,
      text: () => {
        const view = foldSessionMemory(agent.session.events)
        const turns = agent.session.events.filter(event => event.type === 'turn/start').length
        const onboarding = turns === 1 && isEmptyDocument(view.document) ? `\n\n${NEW_SESSION_ONBOARDING}` : ''
        return `${renderSessionMemory(view)}${onboarding}`
      },
    })
  }
}

export default SessionMemoryService

export type { Session }
