import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { installMemoryPrompt } from '../src/memory/prompt.ts'
import { emptySessionMemory } from '../src/memory/fold.ts'

describe('memory and official persona coexistence', () => {
  it.each([false, true])('preserves the official persona with populated requirements = %s', async populated => {
    const ctx = new Context()
    const presetKey = {}, agentKey = {}
    const document = emptySessionMemory()
    const view = { document: { ...document, chat: { ...document.chat, assistantRequirements: populated ? [{ id: 'req', category: '语言', text: '请使用中文', source: 'user' as const, evidenceSeqs: [] }] : [] } }, memoryActivity: [] }
    try {
      await ctx.plugin(SystemPrompt, { personaPrefix: 'Official deployment identity' })
      await ctx.plugin({ inject: ['systemPrompt'], apply(ctx: Context) {
        const preset = createScope(ctx, presetKey)
        preset.ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: 'Official preset identity' })
        const agent = createScope(ctx, agentKey, { parent: presetKey })
        installMemoryPrompt(agent.ctx, () => view)
      } })
      const assembly = await ctx.systemPrompt.assemble({ scope: agentKey })
      expect(assembly.sections.find(row => row.name === PERSONA_PREFIX_SECTION)?.text).toBe('Official preset identity')
      expect(assembly.sections.find(row => row.name === 'session-memory:requirements')?.text).toBe(populated ? '对 AI 的要求：\n- 语言：请使用中文' : '')
      expect(assembly.sections.find(row => row.name === 'session-memory:personalization')?.text).toContain('Chat（日常）')
    } finally { await ctx.fiber.dispose() }
  })
})
