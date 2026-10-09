import { Context } from '@deepseek-ai/cordis'
import CurrentRegistry from '@deepseek-ai/dsh-typert-registry'
import LegacyRegistry from 'dsh-typert-registry-legacy'
import { describe, expect, it } from 'vitest'
import { TYPERT as host } from '../src/generated/typert.host.js'
import remote from '../src/generated/remote.js'
import { emptySessionMemory } from '../src/memory/fold.ts'

describe.each([['0.1.5-rc.2', LegacyRegistry], ['0.2.0-rc.2', CurrentRegistry]] as const)('DSH %s real registry', (_version, Registry) => {
  it('registers host and client endpoints and preserves strict memory validation', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Registry)
      const disposeHost = ctx.typert.register(host)
      const disposeRemote = ctx.typert.remotes.register(remote)
      expect(ctx.typert.local.list()).toHaveLength(5)
      expect(ctx.typert.remotes.list()).toHaveLength(5)
      const view = { document: emptySessionMemory(), memoryActivity: [] }
      for (const descriptors of [host.invocations, remote.descriptors]) {
        const codec = descriptors.find(row => row.method === 'get').result
        expect(codec.create().parse(view)).toEqual(view)
        expect(codec.create().safeParse({ document: { revision: 'invalid' }, memoryActivity: [] }).success).toBe(false)
      }
      disposeHost(); disposeRemote()
      expect(ctx.typert.local.list()).toHaveLength(0)
      expect(ctx.typert.remotes.list()).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('reproduces the 0.2 failure for the old schema-only descriptors', async () => {
  const ctx = new Context()
  const withoutFactory = ({ create: _create, ...codec }) => codec
  const old = { ...host, invocations: host.invocations.map(row => ({ ...row,
    result: withoutFactory(row.result),
    parameters: row.parameters.map(parameter => ({ ...parameter, codec: withoutFactory(parameter.codec) })),
  })) }
  try {
    await ctx.plugin(CurrentRegistry)
    expect(() => ctx.typert.register(old)).toThrow('strict codec has no create() factory')
    expect(ctx.typert.local.list()).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
  }
})
