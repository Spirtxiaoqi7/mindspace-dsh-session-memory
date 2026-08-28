/** Model-facing rendering of the current session-memory document. */

import type { SessionMemoryItem, SessionMemoryView } from './types.ts'

const numerals = ['一', '二', '三', '四', '五'] as const

function cards(label: string, values: readonly SessionMemoryItem[]): string {
  return values.length === 0 ? '' : `${label}：\n${values.map(value => `- ${value.category}：${value.text}`).join('\n')}`
}

export function renderSessionMemory(view: SessionMemoryView): string {
  const { document } = view
  const people = document.people.map((person, index) => [
    `人物${numerals[index] ?? index + 1}`,
    `个体名称：${person.name}`,
    person.information ? `个体信息：${person.information}` : '',
    person.preference ? `人物偏好：${person.preference}` : '',
    person.relationship ? `与当前 AI 的关系及背景：${person.relationship}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
  return [
    '以下是这段对话中存在的人物、要求与记忆。人物一对应当前发言者；其他人物同样构成这个世界并可能影响当前判断。',
    people ? `人物信息：\n${people}` : '',
    cards('对 AI 的要求', document.assistantRequirements),
    cards('记忆', document.memories),
  ].filter(Boolean).join('\n\n')
}
