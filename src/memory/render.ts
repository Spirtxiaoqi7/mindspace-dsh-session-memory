/** Model-facing rendering. Only the selected face is rendered in detail. */

import type { SessionMemoryItem, SessionMemoryView } from './types.ts'

const numerals = ['一', '二', '三', '四', '五'] as const

function cards(label: string, values: readonly SessionMemoryItem[]): string {
  return values.length === 0 ? '' : `${label}：\n${values.map(value => `- ${value.category}：${value.text}`).join('\n')}`
}

export function renderAssistantRequirements(view: SessionMemoryView, mode = view.document.activeMode): string {
  return cards('对 AI 的要求', view.document[mode].assistantRequirements)
}

export function renderSessionMemoryContext(view: SessionMemoryView, mode = view.document.activeMode): string {
  const state = view.document[mode]
  const people = state.people.map((person, index) => [
    `人物${numerals[index] ?? index + 1}`,
    `个体名称：${person.name}`,
    person.information ? `${mode === 'chat' ? '日常信息' : '工作信息'}：${person.information}` : '',
    person.preference ? `${mode === 'chat' ? '日常偏好' : '工作偏好'}：${person.preference}` : '',
    person.relationship ? `${mode === 'chat' ? '与当前 AI 的关系' : '协作关系'}：${person.relationship}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
  return [
    `当前记忆模式：${mode === 'chat' ? 'Chat（日常）' : 'Work（工作）'}。这只是上下文状态，不限制任何工具或行为。`,
    people ? `人物信息：\n${people}` : '',
    state.assistantSetting ? `AI 设定：${state.assistantSetting}` : '',
    state.assistantState ? `${mode === 'chat' ? 'AI 当前衣着与外观' : 'AI 当前工作状态'}：${state.assistantState}` : '',
    cards(mode === 'chat' ? '长期日常记忆' : '长期工作记忆', state.memories),
  ].filter(Boolean).join('\n\n')
}

export function renderBridge(view: SessionMemoryView): string {
  const bridge = view.document.bridge
  return [
    bridge.transitionNote ? `最近转场：${bridge.transitionNote}` : '',
    bridge.pendingWrites.length ? `待目标模式处理的跨域写入：${bridge.pendingWrites.map(item => `${item.id} -> ${item.targetMode}: ${item.instruction}`).join('；')}` : '',
  ].filter(Boolean).join('\n')
}

export function renderSessionMemory(view: SessionMemoryView, mode = view.document.activeMode): string {
  return [renderAssistantRequirements(view, mode), renderSessionMemoryContext(view, mode), renderBridge(view)].filter(Boolean).join('\n\n')
}
