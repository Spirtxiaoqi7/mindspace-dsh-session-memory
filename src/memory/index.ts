/** Session-isolated Chat/Work memory with a neutral two-slot bridge. */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT } from '../generated/typert.host.js'
import { normalizeCompactionPolicy, normalizeSessionMemoryDocument } from './fold.ts'
import { installAutomaticCompactionFallback, installSessionCompactionPolicyBridge, readSessionCompactionStatus } from './compaction-bridge.ts'
import { SessionMemorySidecar } from './sidecar.ts'
import { applyMemoryMutation, mutationInstruction, type MutationArgs } from './mutation.ts'
import { modelSessionMemorySnapshot, renderAssistantRequirements, renderBridge, renderSessionMemory, renderSessionMemoryContext } from './render.ts'
import { ASSISTANT_STATE_REMINDER, needsAssistantStateReminder } from './state-reminder.ts'
import type { BridgePendingWrite, ContextCompactionPolicy, ContextCompactionStatus, ReplaceSessionMemoryRequest, SessionMemoryActivity, SessionMemoryDocument, SessionMemoryFailure, SessionMemoryItem, SessionMemoryMode, SessionMemoryMutationResult, SessionMemorySection, SessionMemoryView, SessionModeMemory, SessionPerson } from './types.ts'

export type * from './types.ts'
export * from './domain.ts'
export { needsAssistantStateReminder } from './state-reminder.ts'
export { applySessionMemoryEvent, emptyModeMemory, emptySessionMemory, emptySessionMemoryFoldState, foldSessionMemory, migrateLegacyDocument, migrateV4Document, sessionMemoryView } from './fold.ts'
export { renderAssistantRequirements, renderBridge, renderSessionMemory, renderSessionMemoryContext } from './render.ts'

export interface Config { readonly maxTextBytes?: number; readonly maxItemsPerSection?: number; readonly maxProfileCharacters?: number }
interface ResolvedConfig { readonly maxTextBytes: number; readonly maxItemsPerSection: number; readonly maxProfileCharacters: number }

declare module '@deepseek-ai/cordis' { interface Context { mindspaceSessionMemory: SessionMemoryService } }

const MAX_PEOPLE = 5
const MAX_MEMORY_CARDS = 3
const DEFAULT_PROFILE_CHARACTERS = 300

export const MEMORY_TOOL_GUIDANCE = [
  'Session memory has two task-conditioned faces for the same user and AI: Chat for daily life, relationships, preferences and appearance; Work for projects, engineering and collaboration.',
  'These modes never restrict tools or capabilities. At the start of a turn, keep the current mode when it fits; call route_session_memory only when the latest user intent clearly belongs to the other mode.',
  'A user-selected mode is strong evidence, not an absolute lock. A mixed message may switch once its main intent changes. The route tool returns the newly relevant memory and pending bridge writes.',
  'Memory write duty: when the user explicitly establishes, confirms, corrects, or changes a person, relationship, name, durable preference, instruction for the AI, long-lived fact, or the AI current state, call update_session_memory in that same turn. The user does not need to say "remember". Resolve confirmations such as "this outfit", "keep it this way", or "do this from now on" from the immediately preceding context.',
  'For the AI current Chat appearance/outfit or current Work role/state, prefer the dedicated get_current_assistant_state and set_current_assistant_state tools. Use update_session_memory set_assistant_setting for the stable AI definition. Do not merely enact a confirmed state in prose: persist it as part of completing the request.',
  'Ordinary small talk, momentary actions, one-off tasks, and unconfirmed guesses are not memory. Direct writes are atomic and do not require a preceding read; use get_session_memory only when the existing state or ids are genuinely needed.',
  'Verification duty: when the user asks what is currently remembered or disputes a general remembered fact, call get_session_memory before answering; for current AI appearance/outfit/state use get_current_assistant_state. Treat tool results as authoritative. If a field is empty or inconsistent, say so and persist a user-confirmed correction instead of claiming that prose already changed memory.',
  'Direct writes may only target the active mode. A fact for the other mode must be staged with update_session_memory target_mode; do not place it in the current mode.',
  'After entering a mode, review pending writes targeted there. Use resolve_pending_memory to apply a consolidated update or explicitly skip it; only then is that pending item cleared.',
  'The bridge contains only a short transition note and pending write instructions. Never use it as a second long-term memory. Never invent people or facts.',
].join(' ')

function failure(code: SessionMemoryFailure['code'], message: string): SessionMemoryMutationResult { return { ok: false, error: { code, message } } }
function validateText(value: string, field: string, maxBytes: number, allowBlank = false): SessionMemoryFailure | undefined {
  if (!allowBlank && !value.trim()) return { code: 'invalid-document', message: `${field} must not be blank` }
  return Buffer.byteLength(value, 'utf8') > maxBytes ? { code: 'text-too-large', message: `${field} exceeds ${maxBytes} bytes` } : undefined
}

function validateItems(items: readonly SessionMemoryItem[], field: string, config: ResolvedConfig): SessionMemoryFailure | undefined {
  if (items.length > config.maxItemsPerSection) return { code: 'invalid-document', message: `${field} has more than ${config.maxItemsPerSection} cards` }
  const ids = new Set<string>(); const categories = new Set<string>()
  for (const [index, item] of items.entries()) {
    for (const [name, value] of [['id', item.id], ['category', item.category], ['text', item.text]] as const) {
      const invalid = validateText(value, `${field}[${index}].${name}`, config.maxTextBytes); if (invalid) return invalid
    }
    const category = item.category.trim().toLocaleLowerCase()
    if (ids.has(item.id) || categories.has(category)) return { code: 'invalid-document', message: `${field} contains a duplicate id or category` }
    ids.add(item.id); categories.add(category)
  }
  return undefined
}

function validateMode(mode: SessionModeMemory, field: string, config: ResolvedConfig): SessionMemoryFailure | undefined {
  if (mode.people.length > MAX_PEOPLE) return { code: 'invalid-document', message: `${field}.people exceeds ${MAX_PEOPLE}` }
  for (const [index, person] of mode.people.entries()) {
    const id = validateText(person.id, `${field}.people[${index}].id`, config.maxTextBytes); if (id) return id
    const name = validateText(person.name, `${field}.people[${index}].name`, config.maxTextBytes); if (name) return name
    if ([...person.information].length > config.maxProfileCharacters || [...person.preference].length > config.maxProfileCharacters) return { code: 'text-too-large', message: `${field}.people[${index}] profile exceeds ${config.maxProfileCharacters} characters` }
  }
  for (const [name, value] of [['assistantSetting', mode.assistantSetting], ['assistantState', mode.assistantState]] as const) {
    const invalid = validateText(value, `${field}.${name}`, config.maxTextBytes, true); if (invalid) return invalid
  }
  return validateItems(mode.assistantRequirements, `${field}.assistantRequirements`, config) ?? validateItems(mode.memories, `${field}.memories`, config)
}

function resolveDocument(request: ReplaceSessionMemoryRequest, revision: number, time: number, config: ResolvedConfig): SessionMemoryDocument | SessionMemoryFailure {
  const chatInvalid = validateMode(request.chat, 'chat', config); if (chatInvalid) return chatInvalid
  const workInvalid = validateMode(request.work, 'work', config); if (workInvalid) return workInvalid
  if ([...request.bridge.transitionNote].length > 300) return { code: 'text-too-large', message: 'bridge.transitionNote exceeds 300 characters' }
  for (const item of request.bridge.pendingWrites) {
    const invalid = validateText(item.instruction, 'bridge.pendingWrites.instruction', config.maxTextBytes); if (invalid) return invalid
  }
  return normalizeSessionMemoryDocument({ version: 5, revision, activeMode: request.activeMode, modeSource: request.modeSource, modeReason: request.modeReason, chat: request.chat, work: request.work, bridge: request.bridge, updatedAt: time })
}

function activity(operation: SessionMemoryActivity['operation'], section: SessionMemorySection, mode: SessionMemoryMode | null, before: unknown, after: unknown, reason: string, at: number, sourceSeqs: readonly number[] = []): SessionMemoryActivity {
  const show = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value)
  return { id: `activity-${randomUUID()}`, operation, section, mode, before: show(before), after: show(after), reason, at, sourceSeqs: [...sourceSeqs] }
}

function audit(current: SessionMemoryDocument, next: SessionMemoryDocument, at: number): SessionMemoryActivity[] {
  const rows: SessionMemoryActivity[] = []
  if (current.activeMode !== next.activeMode) rows.push(activity('switch', 'bridge', next.activeMode, current.activeMode, next.activeMode, next.modeReason || 'Mode changed', at))
  for (const mode of ['chat', 'work'] as const) {
    for (const section of ['people', 'assistantSetting', 'assistantState', 'assistantRequirements', 'memories'] as const) {
      if (JSON.stringify(current[mode][section]) !== JSON.stringify(next[mode][section])) rows.push(activity('replace', section, mode, current[mode][section], next[mode][section], 'Memory center updated this field.', at))
    }
  }
  if (current.bridge.transitionNote !== next.bridge.transitionNote) rows.push(activity('replace', 'bridge', null, current.bridge.transitionNote, next.bridge.transitionNote, 'Transition note updated.', at))
  const previousPending = new Map(current.bridge.pendingWrites.map(item => [item.id, item]))
  const nextPending = new Map(next.bridge.pendingWrites.map(item => [item.id, item]))
  for (const item of next.bridge.pendingWrites) if (!previousPending.has(item.id)) rows.push(activity('stage', 'bridge', item.targetMode, null, item.instruction, 'Cross-domain write staged for its target mode.', at, item.sourceSeqs))
  for (const item of current.bridge.pendingWrites) if (!nextPending.has(item.id)) rows.push(activity('consume', 'bridge', item.targetMode, item.instruction, null, 'Pending cross-domain write resolved.', at, item.sourceSeqs))
  return rows
}

function currentRequest(document: SessionMemoryDocument): ReplaceSessionMemoryRequest {
  return { expectedRevision: document.revision, activeMode: document.activeMode, modeSource: document.modeSource, modeReason: document.modeReason, chat: document.chat, work: document.work, bridge: document.bridge }
}

export class SessionMemoryService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'typert', 'commands']
  static Config: z<Config> = z.object({ maxTextBytes: z.number().step(1).min(1).default(4096), maxItemsPerSection: z.number().step(1).min(1).max(MAX_MEMORY_CARDS).default(MAX_MEMORY_CARDS), maxProfileCharacters: z.number().step(1).min(1).default(DEFAULT_PROFILE_CHARACTERS) })
  private readonly resolved: ResolvedConfig
  private readonly installedAgents = new WeakSet<Agent>()
  private readonly store = new SessionMemorySidecar()
  private readonly requestCompactionCheck: (agent: Agent) => void

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mindspaceSessionMemory'); ctx.typert.register(TYPERT)
    this.resolved = { maxTextBytes: config.maxTextBytes ?? 4096, maxItemsPerSection: Math.min(config.maxItemsPerSection ?? MAX_MEMORY_CARDS, MAX_MEMORY_CARDS), maxProfileCharacters: config.maxProfileCharacters ?? DEFAULT_PROFILE_CHARACTERS }
    ctx.systemPrompt.section({ name: 'tool:session-memory', order: 113, text: MEMORY_TOOL_GUIDANCE })
    this.registerTools()
    ctx.on('agent/pre-step', async ({ messages, step }, next) => {
      const decision = await next()
      if (step !== 1 || decision.kind === 'reject' || !needsAssistantStateReminder(messages)) return decision
      return { kind: 'enter', messages: [...decision.messages, { ...ASSISTANT_STATE_REMINDER, id: `${ASSISTANT_STATE_REMINDER.id}-${randomUUID()}` } as typeof decision.messages[number]] }
    })
    installSessionCompactionPolicyBridge(ctx, agent => this.store.read(agent.session).compactionPolicy)
    this.requestCompactionCheck = installAutomaticCompactionFallback(ctx, agent => this.store.read(agent.session).compactionPolicy)
    ctx.inject(['systemPrompt'], (promptCtx) => {
      for (const agent of ctx.agents.roots()) this.installPrompt(agent)
      promptCtx.on('agent/created', ({ agent }) => { if (ctx.agents.roots().includes(agent)) this.installPrompt(agent) })
    })
  }

  @Remote('get') get(agent: Agent): SessionMemoryView { this.assertLive(agent); return this.store.read(agent.session).view }
  @Remote('replace') async replace(agent: Agent, request: ReplaceSessionMemoryRequest): Promise<SessionMemoryMutationResult> { return this.commit(agent, request, []) }
  @Remote('getCompactionPolicy') getCompactionPolicy(agent: Agent): ContextCompactionPolicy { this.assertLive(agent); return normalizeCompactionPolicy(this.store.read(agent.session).compactionPolicy) }
  @Remote('getCompactionStatus') async getCompactionStatus(agent: Agent): Promise<ContextCompactionStatus> {
    this.assertLive(agent); return await readSessionCompactionStatus(agent, this.store.read(agent.session).compactionPolicy, this.ctx.get('commands') !== undefined)
  }
  @Remote('setCompactionPolicy') async setCompactionPolicy(agent: Agent, policy: ContextCompactionPolicy): Promise<ContextCompactionPolicy> {
    this.assertLive(agent); const next = { ...normalizeCompactionPolicy(policy), updatedAt: Date.now() }; const saved = this.store.setPolicy(agent.session, next).compactionPolicy; this.requestCompactionCheck(agent); return saved
  }

  private async commit(agent: Agent, request: ReplaceSessionMemoryRequest, sourceSeqs: readonly number[]): Promise<SessionMemoryMutationResult> {
    this.assertLive(agent); const currentView = this.get(agent); const current = currentView.document
    if (request.expectedRevision !== current.revision) return failure('stale-revision', `expected revision ${request.expectedRevision}; current revision is ${current.revision}`)
    const time = Date.now(); const resolved = resolveDocument(request, current.revision + 1, time, this.resolved)
    if ('code' in resolved) return { ok: false, error: resolved }
    const changes = audit(current, resolved, time)
    if (!changes.length) return { ok: true, value: currentView }
    const view = { document: resolved, memoryActivity: [...currentView.memoryActivity, ...changes.map(change => ({ ...change, sourceSeqs: [...new Set([...change.sourceSeqs, ...sourceSeqs])] }))] }
    this.store.replace(agent.session, view); return { ok: true, value: view }
  }

  private assertLive(agent: Agent): void { if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`session-memory: agent ${agent.id} is not live`) }
  private latestEvidence(agent: Agent): number[] { const event = agent.session.events.findLast(row => row.type === 'user/message' && row.data.source.kind === 'user'); return event ? [event.seq] : [] }
  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'route_session_memory', description: 'Switch Chat/Work memory only when the latest intent clearly belongs to the other mode. This does not change tools or permissions. Returns the selected mode memory and pending bridge writes.',
      parameters: { mode: { type: 'string', required: true, enum: ['chat', 'work'] }, reason: { type: 'string', required: true, description: 'Brief semantic reason for keeping or changing mode.' }, transition_note: { type: 'string', description: 'When switching, <=300 characters: why, destination, and where the previous state stopped.' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec): Promise<JsonValue> => {
        if (!exec.agent) throw new Error('route_session_memory requires an Agent-backed session')
        const view = this.get(exec.agent); const mode = args.mode as SessionMemoryMode
        if (mode !== view.document.activeMode) {
          const request = currentRequest(view.document)
          const result = await this.commit(exec.agent, { ...request, activeMode: mode, modeSource: 'model', modeReason: args.reason, bridge: { ...request.bridge, transitionNote: [...(args.transition_note ?? `${view.document.activeMode} → ${mode}：${args.reason}`)].slice(0, 300).join('') } }, this.latestEvidence(exec.agent))
          if (!result.ok) throw new Error(result.error.message)
          return { mode, memory: renderSessionMemory(result.value, mode), pendingWrites: result.value.document.bridge.pendingWrites.filter(item => item.targetMode === mode) } as unknown as JsonValue
        }
        return { mode, memory: renderSessionMemory(view, mode), pendingWrites: view.document.bridge.pendingWrites.filter(item => item.targetMode === mode) } as unknown as JsonValue
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'get_session_memory', description: 'Inspect the authoritative active memory. Required before answering a user question or dispute about what is currently stored. Returns only the compact active-mode state and bridge; audit history stays in the Memory Center.', parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (_args, exec): Promise<JsonValue> => {
        if (!exec.agent) throw new Error('get_session_memory requires an Agent-backed session')
        return Promise.resolve(modelSessionMemorySnapshot(this.get(exec.agent)) as unknown as JsonValue)
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'get_current_assistant_state', description: 'Read the authoritative current AI appearance, outfit, or active role/state. Call this when the user says the claimed state is not visible, unchanged, or inconsistent.', parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (_args, exec): Promise<JsonValue> => {
        if (!exec.agent) throw new Error('get_current_assistant_state requires an Agent-backed session')
        const document = this.get(exec.agent).document
        return Promise.resolve({ mode: document.activeMode, state: document[document.activeMode].assistantState } as unknown as JsonValue)
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'set_current_assistant_state', description: 'Persist the AI current appearance/outfit or active role/state in the active Chat/Work memory. Required before claiming a confirmed change is now in effect. This is the simple preferred state-write tool.',
      parameters: { state: { type: 'string', required: true, description: 'The complete resolved current state. Use an empty string only when the user explicitly clears it.' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec): Promise<JsonValue> => {
        if (!exec.agent) throw new Error('set_current_assistant_state requires an Agent-backed session')
        const current = this.get(exec.agent).document
        const sourceSeqs = this.latestEvidence(exec.agent)
        const request = currentRequest(current)
        const target = applyMemoryMutation(current[current.activeMode], { action: 'set_assistant_state', assistant_state: args.state }, sourceSeqs)
        const result = await this.commit(exec.agent, { ...request, [current.activeMode]: target }, sourceSeqs)
        if (!result.ok) throw new Error(result.error.message)
        const document = result.value.document
        return { ok: true, mode: document.activeMode, state: document[document.activeMode].assistantState, revision: document.revision } as unknown as JsonValue
      },
    }))
    const mutationParameters = {
      target_mode: { type: 'string', required: true, enum: ['chat', 'work'] }, action: { type: 'string', required: true, enum: ['set_assistant_setting', 'set_assistant_state', 'add_person', 'update_person', 'remove_person', 'upsert_item', 'remove_item'] },
      section: { type: 'string', enum: ['assistantRequirements', 'memories'] }, category: { type: 'string' }, text: { type: 'string' }, item_id: { type: 'string' }, person_id: { type: 'string' }, person_name: { type: 'string' }, information: { type: 'string' }, preference: { type: 'string' }, relationship: { type: 'string' }, assistant_setting: { type: 'string' }, assistant_state: { type: 'string' },
    } as const
    this.ctx.tools.register(defineTool({
      name: 'update_session_memory', description: 'Persist an explicit memory change now in one atomic call, or stage it for the other mode. Use set_assistant_state whenever the user confirms or changes the AI current Chat outfit/appearance or Work role/state; acting it out only in prose is incomplete. A prior get_session_memory call is optional.', parameters: mutationParameters,
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (raw, exec): Promise<JsonValue> => {
        if (!exec.agent) throw new Error('update_session_memory requires an Agent-backed session')
        const current = this.get(exec.agent).document
        const args = raw as unknown as MutationArgs & { target_mode: SessionMemoryMode }; const sourceSeqs = this.latestEvidence(exec.agent); const request = currentRequest(current)
        let next: ReplaceSessionMemoryRequest
        if (args.target_mode === current.activeMode) next = { ...request, [args.target_mode]: applyMemoryMutation(current[args.target_mode], args, sourceSeqs) }
        else {
          const pending: BridgePendingWrite = { id: `pending-${randomUUID()}`, fromMode: current.activeMode, targetMode: args.target_mode, instruction: mutationInstruction(args), suggestedAction: args.action, ...(args.section ? { suggestedSection: args.section } : {}), sourceSeqs, createdAt: Date.now() }
          next = { ...request, bridge: { ...request.bridge, pendingWrites: [...request.bridge.pendingWrites, pending] } }
        }
        const result = await this.commit(exec.agent, next, sourceSeqs); if (!result.ok) throw new Error(result.error.message); return { ok: true, ...modelSessionMemorySnapshot(result.value), revision: result.value.document.revision } as unknown as JsonValue
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'resolve_pending_memory', description: 'After entering a target mode, apply one reviewed pending write with a consolidated mutation, or skip it. Clears only that successfully resolved item.',
      parameters: { pending_id: { type: 'string', required: true }, resolution: { type: 'string', required: true, enum: ['apply', 'skip'] }, reason: { type: 'string', required: true }, ...mutationParameters },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (raw, exec): Promise<JsonValue> => {
        if (!exec.agent) throw new Error('resolve_pending_memory requires an Agent-backed session')
        const args = raw as unknown as MutationArgs & { pending_id: string; resolution: 'apply' | 'skip'; target_mode: SessionMemoryMode; reason: string }
        const view = this.get(exec.agent); const pending = view.document.bridge.pendingWrites.find(item => item.id === args.pending_id)
        if (!pending) throw new Error('pending write not found')
        if (pending.targetMode !== view.document.activeMode || args.target_mode !== pending.targetMode) throw new Error('Switch to the pending write target mode first')
        const sourceSeqs = [...new Set([...pending.sourceSeqs, ...this.latestEvidence(exec.agent)])]; const request = currentRequest(view.document)
        const target = args.resolution === 'apply' ? applyMemoryMutation(view.document[pending.targetMode], args, sourceSeqs) : view.document[pending.targetMode]
        const next = { ...request, [pending.targetMode]: target, bridge: { ...request.bridge, pendingWrites: request.bridge.pendingWrites.filter(item => item.id !== pending.id) } }
        const result = await this.commit(exec.agent, next, sourceSeqs); if (!result.ok) throw new Error(result.error.message); return { ok: true, ...modelSessionMemorySnapshot(result.value), revision: result.value.document.revision } as unknown as JsonValue
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'configure_context_compaction', description: 'Configure context compaction for this conversation only.', parameters: { enabled: { type: 'boolean', required: true }, threshold_percent: { type: 'number' }, retain_tokens: { type: 'number' }, summary_max_tokens: { type: 'number' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec): Promise<JsonValue> => { if (!exec.agent) throw new Error('Agent-backed session required'); return await this.setCompactionPolicy(exec.agent, { version: 1, enabled: args.enabled, thresholdRatio: (args.threshold_percent ?? 16.4) / 100, retainTokens: args.retain_tokens ?? 64_000, maxTokens: args.summary_max_tokens ?? 6_000, updatedAt: Date.now() } as ContextCompactionPolicy) as unknown as JsonValue },
    }))
  }

  private installPrompt(agent: Agent): void {
    if (this.installedAgents.has(agent)) return; this.installedAgents.add(agent)
    agent.ctx.systemPrompt.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: () => renderAssistantRequirements(this.get(agent)) })
    agent.ctx.systemPrompt.section({ name: 'session-memory:personalization', order: 10, text: () => renderSessionMemoryContext(this.get(agent)) })
    agent.ctx.systemPrompt.section({ name: 'session-memory:bridge', order: 11, text: () => renderBridge(this.get(agent)) })
  }
}

export default SessionMemoryService
export type { Session }
