/** Browser settings contribution with a self-mounted session-memory Remote. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import sessionMemoryRemote from '../generated/remote.js'
import { SessionMemorySection } from './SessionMemorySection.tsx'
import type { SessionMemorySectionInjected } from './SessionMemorySection.tsx'
import { en, zh, type SessionMemoryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.sessionMemory': SessionMemoryKey }
}

export const inject = ['slots', 'locale', 'remote']

/** Mount the plugin-owned Remote, then register the Personalization section. */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(sessionMemoryRemote)
  ctx.effect(() => disposeRemote, 'mindspace-session-memory: remote')
  const ns = 'settings.sessionMemory'
  ctx.effect(() => ctx.locale.register(ns, { zh, en }), 'mindspace-session-memory: dictionaries')
  const t = ctx.locale.bind(ns) as SessionMemorySectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'personalization', order: 20, label: () => t('nav'),
    inject: (): SessionMemorySectionInjected => ({
      remote: ctx.remote.sessionMemory as SessionMemorySectionInjected['remote'],
      t,
    }),
  }, SessionMemorySection))
}
