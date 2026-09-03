/** Browser settings contribution with a self-mounted session-memory Remote. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import sessionMemoryRemote from '../generated/remote.js'
import { MemoryModeChip, SessionMemorySection } from './SessionMemorySection.tsx'
import type { SessionMemorySectionInjected } from './SessionMemorySection.tsx'
import { en, zh, type SessionMemoryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.sessionMemory': SessionMemoryKey }
}

// This package uses hand-written strict descriptors.  Its browser face mounts
// the single package contribution atomically before consuming the namespace.
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces']

/** Mount the plugin-owned Remote, then register the Personalization section. */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(sessionMemoryRemote)
  ctx.effect(() => disposeRemote, 'mindspace-session-memory: remote')
  const ns = 'settings.sessionMemory'
  ctx.effect(() => ctx.locale.register(ns, { zh, en }), 'mindspace-session-memory: dictionaries')
  const t = ctx.locale.bind(ns) as SessionMemorySectionInjected['t']
  const remote = ctx.get('remote.mindspaceSessionMemory') as SessionMemorySectionInjected['remote']
  if (remote === undefined) throw new Error('mindspace-session-memory: Remote mount did not publish its namespace')
  const commands = ctx.get('remote.commands') as SessionMemorySectionInjected['commands']
  const inheritance: NonNullable<SessionMemorySectionInjected['inheritance']> = {
    createBlankSession: async (sourceSessionId) => {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sourceSessionId as never))
      if (workspace === undefined) throw new Error('当前会话不属于任何工作区，无法创建继承会话。')
      const targetId = await ctx.workspaces.connectWorkspace(workspace.workspaceId)
      if (targetId === sourceSessionId) throw new Error('当前会话仍是空白会话，请先发送一条消息后再创建设定继承会话。')
      return targetId
    },
    openSession: (sessionId) => { ctx.sessions.open(sessionId as never) },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'personalization', order: 20, label: () => t('nav'),
    inject: (): SessionMemorySectionInjected => ({
      remote,
      commands,
      inheritance,
      t,
    }),
  }, SessionMemorySection))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'session-memory-mode', order: 40,
    inject: () => ({ remote }),
  }, MemoryModeChip))
}
