const ASSISTANT_STATE_SUBJECT = /(外观|衣着|穿着|穿上|换上|换成|换衣|换装|这身|那身|衣服|衬衫|裙|丝袜|浴巾|发型|头发|妆容|当前状态)/u
const ASSISTANT_STATE_CHANGE = /(现在|目前|已经|还是|没有|没|不再|保持|继续|改|变|换|穿|脱|就是|恢复|回到|记住|确认)/u

/** Keep the write duty adjacent to state-changing user text instead of burying it in a long system prompt. */
export function needsAssistantStateReminder(messages: readonly { readonly source: { readonly kind: string }; readonly content: readonly { readonly type: string; readonly text?: string }[] }[]): boolean {
  const latest = messages.findLast(message => message.source.kind === 'user')
  if (latest === undefined) return false
  const text = latest.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  return ASSISTANT_STATE_SUBJECT.test(text) && ASSISTANT_STATE_CHANGE.test(text)
}

export const ASSISTANT_STATE_REMINDER = {
  content: [{ type: 'text' as const, text: '<session-memory-duty>This message may confirm, correct, or change the AI current appearance/outfit/state. Before narrating a state as real, inspect it with get_current_assistant_state when disputed, then persist the resolved current state with set_current_assistant_state. Prose alone does not change memory.</session-memory-duty>' }],
  source: { kind: 'plugin' as const, plugin: 'mindspace-session-memory', form: 'notice' as const, summary: 'current-state write duty' },
  role: 'user' as const,
  id: 'session-memory-current-state-duty',
}
