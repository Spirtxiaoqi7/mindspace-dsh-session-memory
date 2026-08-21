import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { installSessionCompactionPolicyBridge, withSessionCompactionPolicy } from '../src/memory/compaction-bridge.ts'

const policy = {
  enabled: true,
  thresholdRatio: 0.164,
  retainTokens: 64_000,
  maxTokens: 6_000,
  updatedAt: 1,
} as const

describe('DSH 0.1.x session compaction bridge', () => {
  it('applies one session policy without mutating the provider config', () => {
    const config = {
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      maxTokens: 8192,
      modelPolicies: [{ provider: 'deepseek', model: 'flash', thresholdRatio: 0.75 }],
      auto: true,
    }
    const result = withSessionCompactionPolicy(config, { provider: 'deepseek', model: 'flash' }, policy, 98_304)

    expect(result).not.toBe(config)
    expect(config).toEqual(expect.objectContaining({ thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192 }))
    expect(result).toMatchObject({ thresholdRatio: 0.164, retainTokens: 8_060, maxTokens: 6000 })
    expect(result.retainRatio).toBeUndefined()
    expect(result.modelPolicies).toEqual([{ provider: 'deepseek', model: 'flash', thresholdRatio: 0.164, retainTokens: 8_060, retainRatio: undefined, maxTokens: 6000 }])
  })

  it('adds a current-route override without disturbing other model policies', () => {
    const config = {
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      maxTokens: 8192,
      modelPolicies: [{ provider: 'other', model: 'model', thresholdRatio: 0.7 }],
    }
    const result = withSessionCompactionPolicy(config, { provider: 'deepseek', model: 'flash' }, policy)
    expect(result.modelPolicies).toHaveLength(2)
    expect(result.modelPolicies[0]).toMatchObject({ provider: 'deepseek', model: 'flash', maxTokens: 6000 })
    expect(result.modelPolicies[1]).toEqual(config.modelPolicies[0])
  })

  it('falls back to a capacity-independent valid retention ratio', () => {
    const result = withSessionCompactionPolicy({
      thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192, modelPolicies: [],
    }, undefined, policy)
    expect(result).toMatchObject({ thresholdRatio: 0.164, retainRatio: 0.082, retainTokens: undefined })
  })

  it('adapts the preset-scoped provider reached through agent.ctx', async () => {
    const callbacks = new Map<string, (...args: unknown[]) => unknown>()
    let cleanup: (() => void) | undefined
    const ctx = {
      agents: { roots: () => [] },
      on: vi.fn((name: string, callback: (...args: unknown[]) => unknown) => {
        callbacks.set(name, callback)
        return () => undefined
      }),
      effect: vi.fn((factory: () => unknown) => {
        const result = factory()
        if (typeof result === 'function') cleanup = result as () => void
        return () => undefined
      }),
    } as unknown as Context

    const seen: unknown[] = []
    const provider = {
      config: {
        thresholdRatio: 0.8,
        retainRatio: 0.16,
        maxTokens: 8192,
        modelPolicies: [],
      },
      async compactIfNeeded(_agent: Agent, _trigger: 'pressure' | 'context-overflow', _signal: AbortSignal): Promise<null> {
        seen.push({ kind: 'automatic', config: provider.config })
        return null
      },
      async compactNow(_agent: Agent, _signal: AbortSignal, _sourceCommandId?: unknown): Promise<null> {
        seen.push({ kind: 'manual', config: provider.config })
        return null
      },
    }
    const originalIfNeeded = provider.compactIfNeeded
    const originalNow = provider.compactNow
    const agent = {
      ctx: { get: (name: string) => name === 'compaction' ? provider : {
        resolveModelInfo: async () => ({ context: { contextWindow: 98_304 } }),
      } },
      session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'flash' } }) },
      options: {},
    } as unknown as Agent

    installSessionCompactionPolicyBridge(ctx, () => policy)
    callbacks.get('agent/created')?.({ agent })
    await provider.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    await provider.compactNow(agent, new AbortController().signal)

    expect(seen).toEqual([
      { kind: 'automatic', config: expect.objectContaining({ thresholdRatio: 0.164, retainTokens: 8_060, maxTokens: 6000 }) },
      { kind: 'manual', config: expect.objectContaining({ thresholdRatio: 0.164, retainTokens: 8_060, maxTokens: 6000 }) },
    ])
    expect(provider.config).toMatchObject({ thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192 })

    cleanup?.()
    expect(provider.compactIfNeeded).toBe(originalIfNeeded)
    expect(provider.compactNow).toBe(originalNow)
  })
})
