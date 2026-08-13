/** Event-sourced, editable personalization memory scoped to one DSH session. */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionMemoryFoldState } from './fold.ts'
import { applySessionMemoryEvent, emptySessionMemoryFoldState, foldSessionMemory, sessionMemoryView } from './fold.ts'
import { DEFAULT_RELATIONSHIP_MISSION, extractTurn, mergeExtraction } from './extraction.ts'
import { renderSessionMemory } from './render.ts'
import type {
  ReplaceSessionMemoryRequest,
  SessionMemoryDocument,
  SessionMemoryFailure,
  SessionMemoryItem,
  SessionMemoryMutationResult,
  SessionMemoryView,
} from './types.ts'

export type * from './types.ts'
export * from './domain.ts'
export { applySessionMemoryEvent, emptySessionMemory, emptySessionMemoryFoldState, foldSessionMemory, sessionMemoryView } from './fold.ts'
export {
  DEFAULT_RELATIONSHIP_MISSION,
  EXTRACTION_SYSTEM,
  mergeExtraction,
  parseExtraction,
  turnExtractionInput,
} from './extraction.ts'
export { renderSessionMemory } from './render.ts'

/** Deployment policy for memory bounds and optional automatic extraction. */
export interface Config {
  /** Maximum UTF-8 byte length accepted for one editable text field. */
  readonly maxTextBytes?: number
  /** Maximum number of entries retained in each list-shaped memory section. */
  readonly maxItemsPerSection?: number
  /** Run conservative memory extraction after completed root-agent turns. */
  readonly autoExtract?: boolean
  /** Maximum output tokens requested from the auxiliary extraction model call. */
  readonly extractionMaxTokens?: number
}

interface ResolvedConfig {
  readonly maxTextBytes: number
  readonly maxItemsPerSection: number
  readonly autoExtract: boolean
  readonly extractionMaxTokens: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionMemory: SessionMemoryService
  }
}

const memoryItemSchema = zod.object({
  id: zod.string(), text: zod.string(), source: zod.enum(['user', 'extracted']), evidenceSeqs: zod.array(zod.number()),
})
const relationshipSchema = zod.object({ role: zod.string(), mission: zod.string(), guidance: zod.string() })
const roleplayPresetSchema = zod.object({ enabled: zod.boolean(), text: zod.string() })
const contentBlockSchema = zod.custom<ContentBlock>(value => (
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
))
const documentSchema = zod.object({
  version: zod.literal(1), revision: zod.number(), summaryOverride: zod.string().nullable(),
  preferences: zod.array(memoryItemSchema), userFacts: zod.array(memoryItemSchema),
  assistantInstructions: zod.array(memoryItemSchema), relationship: relationshipSchema.nullable(),
  roleplayPreset: roleplayPresetSchema.nullable(), updatedAt: zod.number(),
})
const summarySchema = zod.object({
  content: zod.array(contentBlockSchema),
  text: zod.string(),
  source: zod.enum(['compaction', 'user']),
  sourceSeq: zod.number(),
})
const viewSchema = zod.object({
  document: documentSchema,
  compactionSummary: summarySchema.nullable(),
  summary: summarySchema.nullable(),
})

const MEMORY_TOOL_GUIDANCE = [
  'Session memory is important durable user state. You MUST call update_session_memory before replying whenever the',
  'user explicitly states or changes a stable preference, personal fact, assistant rule, relationship, identity,',
  'conversation purpose, or roleplay preset. The user does not need to say "remember". Requests such as "be my wife",',
  '"act as my mentor", "use Rust", and "do not do X" are direct memory triggers even when unrelated to coding.',
  'Do not reject or ignore a relationship merely because your base identity is a coding agent; save the session-local',
  'role and then respond within applicable boundaries. Read memory first before correcting or deleting so you can pass',
  'the exact item id. A newer explicit user statement is authoritative and may replace conflicting older memory.',
  'Never write guesses or inferred sensitive facts. These tools can access only the current conversation.',
].join(' ')

const NEW_SESSION_ONBOARDING = [
  'This is the first turn of a session with no personalization yet. Address the user request first, then ask at most',
  'one short optional question about the role, purpose, or response style they want for this conversation. If the user',
  'already supplied any of those, do not ask again: persist the explicit setting with update_session_memory instead.',
].join(' ')

type SessionMemoryRemoteInitializer = (this: SessionMemoryService) => void
const SESSION_MEMORY_REMOTE_INITIALIZERS: SessionMemoryRemoteInitializer[] = []

function isEmptyDocument(document: SessionMemoryDocument): boolean {
  return document.summaryOverride === null
    && document.preferences.length === 0
    && document.userFacts.length === 0
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
    return {
      code: 'invalid-document',
      message: `${field} has ${items.length} items; limit is ${config.maxItemsPerSection}`,
    }
  }
  const ids = new Set<string>()
  for (const [index, item] of items.entries()) {
    const idError = validateText(item.id, `${field}[${index}].id`, config.maxTextBytes)
    if (idError !== undefined) return idError
    const textError = validateText(item.text, `${field}[${index}].text`, config.maxTextBytes)
    if (textError !== undefined) return textError
    if (ids.has(item.id)) return { code: 'invalid-document', message: `${field} repeats item id ${JSON.stringify(item.id)}` }
    ids.add(item.id)
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
    ['preferences', request.preferences], ['userFacts', request.userFacts], ['assistantInstructions', request.assistantInstructions],
  ] as const) {
    const invalid = validateItems(items, field, config)
    if (invalid !== undefined) return invalid
  }
  if (request.summaryOverride !== null) {
    const invalid = validateText(request.summaryOverride, 'summaryOverride', config.maxTextBytes)
    if (invalid !== undefined) return invalid
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
    version: 1, revision, summaryOverride: request.summaryOverride,
    preferences: request.preferences.map(item => ({
      ...item, text: item.text.trim(), evidenceSeqs: [...item.evidenceSeqs],
    })),
    userFacts: request.userFacts.map(item => ({
      ...item, text: item.text.trim(), evidenceSeqs: [...item.evidenceSeqs],
    })),
    assistantInstructions: request.assistantInstructions.map(item => ({
      ...item, text: item.text.trim(), evidenceSeqs: [...item.evidenceSeqs],
    })),
    relationship: request.relationship === null
      ? null
      : {
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

/** Session-memory service: Remote read/edit, replay projection, prompt contribution, and extraction. */
export class SessionMemoryService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'tools', 'systemPrompt']
  static Config: z<Config> = z.object({
    maxTextBytes: z.number().step(1).min(1).default(4096),
    maxItemsPerSection: z.number().step(1).min(1).default(64),
    autoExtract: z.boolean().default(true),
    extractionMaxTokens: z.number().step(1).min(1).default(1024),
  })

  private readonly resolved: ResolvedConfig
  private readonly installedAgents = new WeakSet<Agent>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionMemory')
    for (const initialize of SESSION_MEMORY_REMOTE_INITIALIZERS) initialize.call(this)
    this.resolved = {
      maxTextBytes: config.maxTextBytes ?? 4096,
      maxItemsPerSection: config.maxItemsPerSection ?? 64,
      autoExtract: config.autoExtract ?? true,
      extractionMaxTokens: config.extractionMaxTokens ?? 1024,
    }
    ctx.systemPrompt.section({ name: 'tool:session-memory', order: 113, text: MEMORY_TOOL_GUIDANCE })
    this.registerTools()
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'session-memory', SessionMemoryFoldState>({
        key: 'session-memory', schema: viewSchema, init: emptySessionMemoryFoldState,
        apply: applySessionMemoryEvent, view: sessionMemoryView, stateVersion: 1,
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
            const next = mergeExtraction(current, proposal, result?.data.sourceSeqs ?? [], Date.now())
            const changed = next.preferences.length !== current.preferences.length
              || next.userFacts.length !== current.userFacts.length
              || next.assistantInstructions.length !== current.assistantInstructions.length
              || JSON.stringify(next.relationship) !== JSON.stringify(current.relationship)
              || JSON.stringify(next.roleplayPreset) !== JSON.stringify(current.roleplayPreset)
            if (changed) {
              const validated = resolveDocument({
                expectedRevision: current.revision,
                summaryOverride: next.summaryOverride,
                preferences: next.preferences,
                userFacts: next.userFacts,
                assistantInstructions: next.assistantInstructions,
                relationship: next.relationship,
                roleplayPreset: next.roleplayPreset,
              }, next.revision, next.updatedAt, this.resolved)
              if ('code' in validated) {
                ctx.logger.warn(`session-memory extraction rejected for session ${agent.id}: ${validated.message}`)
                return
              }
              agent.session.append('session-memory/change', {
                version: 1, operation: 'replace', document: validated,
              })
            }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.warn(`session-memory extraction failed for session ${agent.id}: ${message}`)
          }
        })
      })
    }
  }

  /** Read one live session's current memory view. */
  get(agent: Agent): SessionMemoryView {
    this.assertLive(agent)
    return foldSessionMemory(agent.session.events)
  }

  /** Replace editable fields if the caller observed the current revision. */
  async replace(agent: Agent, request: ReplaceSessionMemoryRequest): Promise<SessionMemoryMutationResult> {
    this.assertLive(agent)
    const current = foldSessionMemory(agent.session.events).document
    if (request.expectedRevision !== current.revision) {
      return failure(
        'stale-revision',
        `expected revision ${request.expectedRevision}; current revision is ${current.revision}`,
      )
    }
    const resolved = resolveDocument(request, current.revision + 1, Date.now(), this.resolved)
    if ('code' in resolved) return { ok: false, error: resolved }
    agent.session.append('session-memory/change', { version: 1, operation: 'replace', document: resolved })
    await this.ctx.sessions.flush(agent.session)
    return { ok: true, value: foldSessionMemory(agent.session.events) }
  }

  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`session-memory: agent ${agent.id} is not live`)
  }

  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'get_session_memory',
      description: 'Read editable memory for the current conversation. Use before correcting, replacing, or deleting '
        + 'memory so update_session_memory can receive the exact existing item id.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (_args, exec): Promise<JsonValue> => {
        if (exec.agent === undefined) throw new Error('get_session_memory requires an Agent-backed session')
        return Promise.resolve(this.get(exec.agent) as unknown as JsonValue)
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'update_session_memory',
      description: 'Persist explicit user personalization in the current conversation only, before replying. The user '
        + 'does not need to say remember: stable preferences, facts, assistant rules, relationships, identities, '
        + 'conversation purposes, and roleplay requests all trigger this tool. Replace conflicts by exact item id.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: [
            'upsert_item', 'remove_item', 'set_relationship', 'clear_relationship',
            'set_roleplay_preset', 'clear_roleplay_preset',
          ],
        },
        section: {
          type: 'string',
          enum: ['preferences', 'userFacts', 'assistantInstructions'],
          description: 'Required for item actions.',
        },
        text: { type: 'string', description: 'New item text or roleplay preset text.' },
        item_id: {
          type: 'string',
          description: 'Exact item id returned by get_session_memory; replacement or removal target.',
        },
        role: { type: 'string', description: 'Relationship identity.' },
        mission: { type: 'string', description: 'Optional purpose assigned to this conversation.' },
        guidance: { type: 'string', description: 'Optional relationship guidance.' },
        enabled: { type: 'boolean', description: 'Whether a roleplay preset is injected. Defaults to true when setting.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec): Promise<JsonValue> => {
        if (exec.agent === undefined) throw new Error('update_session_memory requires an Agent-backed session')
        const current = this.get(exec.agent).document
        const request: ReplaceSessionMemoryRequest = {
          expectedRevision: current.revision,
          summaryOverride: current.summaryOverride,
          preferences: [...current.preferences],
          userFacts: [...current.userFacts],
          assistantInstructions: [...current.assistantInstructions],
          relationship: current.relationship,
          roleplayPreset: current.roleplayPreset,
        }
        if (args.action === 'upsert_item' || args.action === 'remove_item') {
          if (args.section === undefined) throw new Error('section is required for item actions')
          const entries = [...request[args.section]]
          const at = args.item_id === undefined ? -1 : entries.findIndex(entry => entry.id === args.item_id)
          if (args.item_id !== undefined && at < 0) {
            throw new Error(`memory item ${args.item_id} does not exist in ${args.section}`)
          }
          if (args.action === 'remove_item') {
            if (at < 0) throw new Error('item_id is required for remove_item')
            entries.splice(at, 1)
          } else {
            if (args.text === undefined || args.text.trim().length === 0) {
              throw new Error('text is required for upsert_item')
            }
            const replacedId = at < 0 ? undefined : entries[at]?.id
            const next = {
              id: replacedId ?? `memory-${randomUUID()}`,
              text: args.text,
              source: 'user' as const,
              evidenceSeqs: [],
            }
            if (at < 0) entries.push(next)
            else entries.splice(at, 1, next)
          }
          Object.assign(request, { [args.section]: entries })
        } else if (args.action === 'set_relationship') {
          if (args.role === undefined || args.role.trim().length === 0) {
            throw new Error('role is required for set_relationship')
          }
          Object.assign(request, {
            relationship: {
              role: args.role,
              mission: args.mission ?? current.relationship?.mission ?? DEFAULT_RELATIONSHIP_MISSION,
              guidance: args.guidance ?? '',
            },
          })
        } else if (args.action === 'clear_relationship') {
          Object.assign(request, { relationship: null })
        } else if (args.action === 'set_roleplay_preset') {
          if (args.text === undefined || args.text.trim().length === 0) {
            throw new Error('text is required for set_roleplay_preset')
          }
          Object.assign(request, { roleplayPreset: { enabled: args.enabled ?? true, text: args.text } })
        } else {
          Object.assign(request, { roleplayPreset: null })
        }
        const result = await this.replace(exec.agent, request)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value as unknown as JsonValue
      },
    }))
  }

  private installPrompt(agent: Agent): void {
    if (this.installedAgents.has(agent)) return
    this.installedAgents.add(agent)
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

function markRemoteMethod(method: 'get' | 'replace'): void {
  const target = SessionMemoryService.prototype[method] as (this: SessionMemoryService, ...args: never[]) => unknown
  Remote(method)(target, {
    name: method,
    kind: 'method',
    static: false,
    private: false,
    access: {
      has: (value: unknown) => method in (value as object),
      get: (value: unknown) => (value as SessionMemoryService)[method] as typeof target,
    },
    addInitializer: (initializer: SessionMemoryRemoteInitializer) => {
      SESSION_MEMORY_REMOTE_INITIALIZERS.push(initializer)
    },
  } as ClassMethodDecoratorContext<SessionMemoryService, typeof target>)
}

markRemoteMethod('get')
markRemoteMethod('replace')

export type { Session }
