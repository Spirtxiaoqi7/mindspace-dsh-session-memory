/** Memory requirements supplement the official persona in their own section. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SessionMemoryView } from './types.ts'
import { renderAssistantRequirements, renderBridge, renderSessionMemoryContext } from './render.ts'

export function installMemoryPrompt(ctx: Context, read: () => SessionMemoryView): void {
  ctx.systemPrompt.section({ name: 'session-memory:requirements', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: () => renderAssistantRequirements(read()) })
  ctx.systemPrompt.section({ name: 'session-memory:personalization', order: 10, text: () => renderSessionMemoryContext(read()) })
  ctx.systemPrompt.section({ name: 'session-memory:bridge', order: 11, text: () => renderBridge(read()) })
}
