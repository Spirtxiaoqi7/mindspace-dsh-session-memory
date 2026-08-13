/** DeepSeek-compatible auxiliary extraction for explicit session-local memory. */

import { randomUUID } from 'node:crypto'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionMemoryDocument, SessionMemoryItem, SessionRelationship, SessionRoleplayPreset } from './types.ts'

export const EXTRACTION_SYSTEM = [
  'Session memory is important. Extract explicit, durable, session-local personalization from the newest USER message.',
  'Return JSON only with arrays preferences, userFacts, assistantInstructions; entries are',
  '{"text":"...","replaces":["existing-item-id"]}. Use replaces only when the user explicitly corrects or',
  'contradicts listed current memory; a newer explicit statement is authoritative. Optional relationship',
  '{role, mission, guidance} MUST be emitted after an explicit relationship, identity, or conversation-purpose',
  'assignment, even when it is casual, roleplay-oriented, or unrelated to coding. For example, "be my wife" assigns',
  'the wife role. Optional roleplayPreset {enabled,text} requires an explicit roleplay rule or change. Judge only the',
  'user message: an assistant refusal or claim never cancels explicit user input. Do not infer sensitive facts, intent,',
  'personality, or unrequested relationships.',
].join(' ')

export const DEFAULT_RELATIONSHIP_MISSION
  = 'Interact using the relationship explicitly assigned by the user in this session.'

interface ExtractionItemProposal {
  text: string
  replaces: string[]
}

interface ExtractionProposal {
  preferences: ExtractionItemProposal[]
  userFacts: ExtractionItemProposal[]
  assistantInstructions: ExtractionItemProposal[]
  relationship?: SessionRelationship
  roleplayPreset?: SessionRoleplayPreset
}

function proposals(value: unknown): ExtractionItemProposal[] {
  if (!Array.isArray(value)) return []
  const result: ExtractionItemProposal[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      result.push({ text: item.trim(), replaces: [] })
      continue
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    if (typeof row['text'] !== 'string' || row['text'].trim().length === 0) continue
    result.push({
      text: row['text'].trim(),
      replaces: Array.isArray(row['replaces'])
        ? row['replaces'].filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : [],
    })
  }
  return result
}

/** Parse the extractor's strict JSON response. */
export function parseExtraction(text: string): ExtractionProposal | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const relation = record['relationship']
    const preset = record['roleplayPreset']
    let relationship: SessionRelationship | undefined
    let roleplayPreset: SessionRoleplayPreset | undefined
    if (typeof relation === 'object' && relation !== null && !Array.isArray(relation)) {
      const row = relation as Record<string, unknown>
      if (typeof row['role'] === 'string') {
        relationship = {
          role: row['role'].trim(),
          mission: typeof row['mission'] === 'string' && row['mission'].trim().length > 0
            ? row['mission'].trim()
            : DEFAULT_RELATIONSHIP_MISSION,
          guidance: typeof row['guidance'] === 'string' ? row['guidance'].trim() : '',
        }
        if (relationship.role.length === 0) relationship = undefined
      }
    }
    if (typeof preset === 'object' && preset !== null && !Array.isArray(preset)) {
      const row = preset as Record<string, unknown>
      if (typeof row['enabled'] === 'boolean' && typeof row['text'] === 'string' && row['text'].trim().length > 0) {
        roleplayPreset = { enabled: row['enabled'], text: row['text'].trim() }
      }
    }
    return {
      preferences: proposals(record['preferences']),
      userFacts: proposals(record['userFacts']),
      assistantInstructions: proposals(record['assistantInstructions']),
      ...(relationship === undefined ? {} : { relationship }),
      ...(roleplayPreset === undefined ? {} : { roleplayPreset }),
    }
  } catch (_invalidJson) {
    return undefined
  }
}

function mergeItems(
  current: readonly SessionMemoryItem[],
  additions: readonly ExtractionItemProposal[],
  evidenceSeqs: readonly number[],
): SessionMemoryItem[] {
  const next = [...current]
  for (const addition of additions) {
    const targets = new Set(addition.replaces)
    const first = next.findIndex(item => targets.has(item.id))
    const retained = next.filter(item => !targets.has(item.id))
    if (retained.some(item => item.text.toLocaleLowerCase() === addition.text.toLocaleLowerCase())) {
      next.splice(0, next.length, ...retained)
      continue
    }
    const replacement = {
      id: first < 0 ? `memory-${randomUUID()}` : next[first]?.id ?? `memory-${randomUUID()}`,
      text: addition.text,
      source: 'extracted' as const,
      evidenceSeqs: [...evidenceSeqs],
    }
    retained.splice(first < 0 ? retained.length : Math.min(first, retained.length), 0, replacement)
    next.splice(0, next.length, ...retained)
  }
  return next
}

/** Apply accepted additions and exact evidence-backed conflict replacements. */
export function mergeExtraction(
  document: SessionMemoryDocument,
  proposal: ExtractionProposal,
  evidenceSeqs: readonly number[],
  time: number,
): SessionMemoryDocument {
  return {
    ...document,
    revision: document.revision + 1,
    preferences: mergeItems(document.preferences, proposal.preferences, evidenceSeqs),
    userFacts: mergeItems(document.userFacts, proposal.userFacts, evidenceSeqs),
    assistantInstructions: mergeItems(document.assistantInstructions, proposal.assistantInstructions, evidenceSeqs),
    relationship: proposal.relationship ?? document.relationship,
    roleplayPreset: proposal.roleplayPreset ?? document.roleplayPreset,
    updatedAt: time,
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
  const input = turnExtractionInput(agent.session.events, turn)
  const route = agent.session.requestHeader()?.config
  if (input === undefined || route === undefined) return undefined
  const currentMemory = JSON.stringify({
    preferences: current.preferences.map(({ id, text }) => ({ id, text })),
    userFacts: current.userFacts.map(({ id, text }) => ({ id, text })),
    assistantInstructions: current.assistantInstructions.map(({ id, text }) => ({ id, text })),
    relationship: current.relationship,
    roleplayPreset: current.roleplayPreset,
  })
  const extractionInput = `${input.input}\n\nCURRENT_SESSION_MEMORY:\n${currentMemory}`
  agent.session.append('session-memory/extraction-request', {
    version: 1,
    turn,
    provider: route.provider,
    model: route.model,
    system: EXTRACTION_SYSTEM,
    input: extractionInput,
    maxTokens,
    sourceSeqs: input.sourceSeqs,
  })
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
    version: 1,
    turn,
    rawOutput: blocks,
    accepted: proposal !== undefined,
    sourceSeqs: input.sourceSeqs,
  })
  return proposal
}
