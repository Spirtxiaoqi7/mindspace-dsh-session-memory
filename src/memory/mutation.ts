/** Pure, atomic mutations for one Chat or Work memory face. */

import { randomUUID } from 'node:crypto'
import type { SessionMemoryItem, SessionModeMemory } from './types.ts'

const MAX_PEOPLE = 5
const MAX_MEMORY_CARDS = 3

export type MemoryAction = 'set_assistant_setting' | 'set_assistant_state' | 'add_person' | 'update_person' | 'remove_person' | 'upsert_item' | 'remove_item'

export interface MutationArgs {
  action: MemoryAction
  section?: 'assistantRequirements' | 'memories'
  category?: string
  text?: string
  item_id?: string
  person_id?: string
  person_name?: string
  information?: string
  preference?: string
  relationship?: string
  assistant_setting?: string
  assistant_state?: string
}

function upsertCard(entries: readonly SessionMemoryItem[], args: MutationArgs, sourceSeqs: readonly number[]): SessionMemoryItem[] {
  if (!args.text?.trim() || !args.category?.trim()) throw new Error('category and text are required')
  const next = [...entries]
  const at = args.item_id ? next.findIndex(item => item.id === args.item_id) : next.findIndex(item => item.category.toLocaleLowerCase() === args.category!.trim().toLocaleLowerCase())
  const value: SessionMemoryItem = { id: next[at]?.id ?? `memory-${randomUUID()}`, category: args.category.trim(), text: args.text.trim(), source: 'user', evidenceSeqs: [...new Set([...(next[at]?.evidenceSeqs ?? []), ...sourceSeqs])] }
  if (at >= 0) next.splice(at, 1, value)
  else if (next.length < MAX_MEMORY_CARDS) next.push(value)
  else next.splice(next.reduce((best, item, index) => item.text.length < next[best]!.text.length ? index : best, 0), 1, value)
  return next
}

export function applyMemoryMutation(mode: SessionModeMemory, args: MutationArgs, sourceSeqs: readonly number[]): SessionModeMemory {
  if (args.action === 'set_assistant_setting') {
    if (args.assistant_setting === undefined) throw new Error('assistant_setting is required')
    return { ...mode, assistantSetting: args.assistant_setting.trim() }
  }
  if (args.action === 'set_assistant_state') {
    if (args.assistant_state === undefined) throw new Error('assistant_state is required')
    return { ...mode, assistantState: args.assistant_state.trim() }
  }
  if (args.action === 'add_person') {
    if (!args.person_name?.trim()) throw new Error('person_name is required')
    if (mode.people.length >= MAX_PEOPLE) throw new Error(`people already has ${MAX_PEOPLE} entries`)
    return { ...mode, people: [...mode.people, { id: `person-${randomUUID()}`, name: args.person_name.trim(), information: args.information ?? '', preference: args.preference ?? '', relationship: args.relationship ?? '', source: 'user', evidenceSeqs: [...sourceSeqs], updatedAt: Date.now() }] }
  }
  if (args.action === 'update_person' || args.action === 'remove_person') {
    if (!args.person_id) throw new Error('person_id is required')
    const people = [...mode.people]; const at = people.findIndex(person => person.id === args.person_id)
    if (at < 0) throw new Error(`person not found: ${args.person_id}`)
    if (args.action === 'remove_person') people.splice(at, 1)
    else { const old = people[at]!; people.splice(at, 1, { ...old, name: args.person_name ?? old.name, information: args.information ?? old.information, preference: args.preference ?? old.preference, relationship: args.relationship ?? old.relationship, source: 'user', evidenceSeqs: [...new Set([...old.evidenceSeqs, ...sourceSeqs])], updatedAt: Date.now() }) }
    return { ...mode, people }
  }
  if (!args.section) throw new Error('section is required')
  if (args.action === 'upsert_item') return { ...mode, [args.section]: upsertCard(mode[args.section], args, sourceSeqs) }
  const entries = [...mode[args.section]]; const at = args.item_id ? entries.findIndex(item => item.id === args.item_id) : entries.findIndex(item => item.category.toLocaleLowerCase() === args.category?.trim().toLocaleLowerCase())
  if (at < 0) throw new Error('matching item not found'); entries.splice(at, 1)
  return { ...mode, [args.section]: entries }
}

export function mutationInstruction(args: MutationArgs): string {
  if (args.action === 'set_assistant_setting') return `更新 AI 设定：${args.assistant_setting ?? ''}`
  if (args.action === 'set_assistant_state') return `更新 AI 当前状态：${args.assistant_state ?? ''}`
  if (args.action.includes('person')) return `${args.action}：${args.person_name ?? args.person_id ?? ''}；信息=${args.information ?? ''}；偏好=${args.preference ?? ''}；关系=${args.relationship ?? ''}`
  return `${args.action} ${args.section ?? ''} / ${args.category ?? args.item_id ?? ''}：${args.text ?? ''}`
}
