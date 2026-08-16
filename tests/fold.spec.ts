import { describe, expect, it } from 'vitest'
import { DEFAULT_COMPACTION_POLICY, foldCompactionPolicy, normalizeCompactionPolicy } from '../src/memory/fold.ts'

describe('compaction policy replay', () => {
  it('repairs legacy policies missing a timestamp before crossing the Remote boundary', () => {
    const policy = foldCompactionPolicy([{
      type: 'mindspace-compaction/policy',
      data: { enabled: false, thresholdRatio: 0.2, retainTokens: 32_000, maxTokens: 4_000 },
    }] as never)
    expect(policy).toEqual({ enabled: false, thresholdRatio: 0.2, retainTokens: 32_000, maxTokens: 4_000, updatedAt: 0 })
  })

  it('never emits non-finite or incomplete values', () => {
    expect(normalizeCompactionPolicy({ enabled: true, thresholdRatio: Number.NaN, retainTokens: 1, maxTokens: 9_999, updatedAt: Number.NaN }))
      .toEqual(DEFAULT_COMPACTION_POLICY)
  })
})
