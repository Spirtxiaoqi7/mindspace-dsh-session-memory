import { describe, expect, it } from 'vitest'
import { withSessionCompactionPolicy } from '../src/memory/compaction-bridge.ts'

const policy = {
  enabled: true,
  thresholdRatio: 0.164,
  retainTokens: 64_000,
  maxTokens: 6_000,
  updatedAt: 1,
} as const

describe('RC8 session compaction bridge', () => {
  it('applies one session policy without mutating the provider config', () => {
    const config = {
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      maxTokens: 8192,
      modelPolicies: [{ provider: 'deepseek', model: 'flash', thresholdRatio: 0.75 }],
      auto: true,
    }
    const result = withSessionCompactionPolicy(config, { provider: 'deepseek', model: 'flash' }, policy)

    expect(result).not.toBe(config)
    expect(config).toEqual(expect.objectContaining({ thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192 }))
    expect(result).toMatchObject({ thresholdRatio: 0.164, retainTokens: 64_000, maxTokens: 6000 })
    expect(result.retainRatio).toBeUndefined()
    expect(result.modelPolicies).toEqual([{ provider: 'deepseek', model: 'flash', thresholdRatio: 0.164, retainTokens: 64_000, retainRatio: undefined, maxTokens: 6000 }])
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
})
