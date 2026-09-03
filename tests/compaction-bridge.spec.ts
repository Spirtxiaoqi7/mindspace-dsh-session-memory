import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { installAutomaticCompactionFallback, installSessionCompactionPolicyBridge, readSessionCompactionStatus, withSessionCompactionPolicy } from '../src/memory/compaction-bridge.ts'

const policy = {
  enabled: true,
  thresholdRatio: 0.164,
  retainTokens: 64_000,
  maxTokens: 6_000,
  updatedAt: 1,
} as const

describe('DSH 0.1.x session compaction bridge', () => {
  it('reports the real pressure budget and the latest automatic result', async () => {
    const agent = {
      ctx: { get: (name: string) => {
        if (name === 'compaction') return { config: { modelPolicies: [] }, compactIfNeeded() {}, compactNow() {} }
        if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 20_000 }) }
        if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 98_304 } }) }
        return undefined
      } },
      session: {
        requestHeader: () => ({ config: { provider: 'deepseek', model: 'flash' } }),
        events: [
          { type: 'compaction/start', time: 10, data: { compactionId: 'auto-1', turn: 4 } },
          { type: 'compaction/end', time: 20, data: { compactionId: 'auto-1', turn: 4 } },
        ],
      },
      options: {},
    } as unknown as Agent
    const status = await readSessionCompactionStatus(agent, policy)
    expect(status).toMatchObject({
      providerAvailable: true,
      contextWindow: 98_304,
      estimatedTokens: 20_000,
      thresholdTokens: 16_121,
      effectiveRetainTokens: 8_060,
      state: 'due',
      lastCompaction: { kind: 'automatic', status: 'completed', at: 20, error: '' },
    })
  })

  it('invokes stock /compact once after an over-threshold completed turn', async () => {
    const callbacks = new Map<string, (...args: any[]) => unknown>()
    const execute = vi.fn(async () => ({ commandId: 'cmd-auto-1', result: { kind: 'success' as const } }))
    const ctx = {
      get: (name: string) => name === 'commands' ? { execute } : undefined,
      on: (name: string, callback: (...args: any[]) => unknown) => { callbacks.set(name, callback); return () => undefined },
    } as unknown as Context
    const agent = {
      ctx: { get: (name: string) => name === 'tokenMeter' ? { measure: () => ({ totalTokens: 20_000 }) } : name === 'llm' ? { resolveModelInfo: async () => ({ context: { contextWindow: 98_304 } }) } : undefined },
      session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'flash' } }), events: [{ type: 'turn/end', seq: 9 }] },
      options: {},
    } as unknown as Agent
    installAutomaticCompactionFallback(ctx, () => policy)
    callbacks.get('agent/status')?.({ agent, status: 'idle' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    callbacks.get('agent/status')?.({ agent, status: 'idle' })
    await Promise.resolve()
    expect(execute).toHaveBeenCalledWith(agent, '/compact', [], expect.any(AbortSignal))
    expect(execute).toHaveBeenCalledTimes(1)
  })

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

  it('normalizes an omitted optional model policy table from the live provider', () => {
    const result = withSessionCompactionPolicy({
      thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192,
    }, { provider: 'deepseek', model: 'flash' }, policy, 98_304)
    expect(result.modelPolicies).toEqual([
      expect.objectContaining({ provider: 'deepseek', model: 'flash', thresholdRatio: 0.164 }),
    ])
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
