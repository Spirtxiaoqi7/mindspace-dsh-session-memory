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

// The Remote is mounted by this plugin in apply().  Declaring the same
// namespace as an injection prerequisite creates a boot-time self-wait: the
// client cannot reach apply() until a service it has not mounted yet exists.
export const inject = ['slots', 'locale', 'remote']

/** Mount the plugin-owned Remote, then register the Personalization section. */
export async function apply(ctx: ClientContext): Promise<void> {
  try {
    const disposeRemote = await ctx.remote.$mount(sessionMemoryRemote)
    ctx.effect(() => disposeRemote, 'mindspace-session-memory: remote')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('sessionMemory/get is already mounted')) throw error
  }
  const ns = 'settings.sessionMemory'
  ctx.effect(() => ctx.locale.register(ns, { zh, en }), 'mindspace-session-memory: dictionaries')
  const t = ctx.locale.bind(ns) as SessionMemorySectionInjected['t']
  // Resolve the namespace only after this plugin has mounted it.  Accessing
  // ctx.remote.sessionMemory inside the slot callback is rejected by the
  // runtime's dependency guard because this plugin intentionally does not
  // declare its own Remote as a boot prerequisite.
    const remote = ctx.get('remote.sessionMemory') as SessionMemorySectionInjected['remote']
    if (remote === undefined) throw new Error('mindspace-session-memory: mounted Remote namespace is unavailable')
    const commands = ctx.get('remote.commands') as SessionMemorySectionInjected['commands']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'personalization', order: 20, label: () => t('nav'),
    inject: (): SessionMemorySectionInjected => ({
      remote,
      commands,
      t,
    }),
  }, SessionMemorySection))
}
