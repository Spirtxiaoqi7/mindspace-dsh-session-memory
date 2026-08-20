/**
 * Session-local policy adapter for the stock RC8 compaction provider.
 *
 * DSH exposes one global `ctx.compaction` service while Mindspace stores its
 * controls in individual session logs.  This adapter keeps that ownership
 * boundary intact: no DSH source is patched and the stock provider remains the
 * only surface rewriter.  Each invocation receives a detached effective
 * config, then the provider is restored before another session may compact.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { foldCompactionPolicy } from './fold.ts'
import type { ContextCompactionPolicy } from './types.ts'

type Target = Pick<LlmCallConfig, 'provider' | 'model'>

type CompactPolicy = {
  readonly provider: string
  readonly model: string
  readonly thresholdRatio?: number
  readonly retainRatio?: number
  readonly retainTokens?: number
  readonly maxTokens?: number
}

type ProviderConfig = {
  readonly thresholdRatio: number
  readonly retainRatio?: number
  readonly retainTokens?: number
  readonly maxTokens: number
  readonly modelPolicies: readonly CompactPolicy[]
  readonly [key: string]: unknown
}

interface MutableCompactionProvider {
  config: ProviderConfig
  compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>
}

/** Public structural boundary; RC8's BasicCompactionEngine satisfies this shape. */
function isMutableProvider(value: unknown): value is MutableCompactionProvider {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<MutableCompactionProvider>
  return typeof candidate.compactIfNeeded === 'function'
    && candidate.config !== null && typeof candidate.config === 'object'
    && Array.isArray(candidate.config.modelPolicies)
}

function routedTarget(agent: Agent): Target | undefined {
  const route = agent.session.requestHeader()?.config
  if (route !== undefined && route.provider.length > 0 && route.model.length > 0) {
    return { provider: route.provider, model: route.model }
  }
  if (agent.options.provider === undefined || agent.options.model === undefined) return undefined
  if (agent.options.provider.length === 0 || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/** Build an isolated stock-provider config with this session's explicit values. */
export function withSessionCompactionPolicy(
  config: ProviderConfig,
  target: Target | undefined,
  policy: ContextCompactionPolicy,
): ProviderConfig {
  const base: ProviderConfig = {
    ...config,
    thresholdRatio: policy.thresholdRatio,
    retainTokens: policy.retainTokens,
    retainRatio: undefined,
    maxTokens: policy.maxTokens,
    modelPolicies: [...config.modelPolicies],
  }
  if (target === undefined) return base

  const existing = config.modelPolicies.find(item => (
    item.provider === target.provider && item.model === target.model
  ))
  const override: CompactPolicy = {
    ...existing,
    provider: target.provider,
    model: target.model,
    thresholdRatio: policy.thresholdRatio,
    retainTokens: policy.retainTokens,
    retainRatio: undefined,
    maxTokens: policy.maxTokens,
  }
  return {
    ...base,
    // `resolveTargetPolicy()` takes the first exact match. Replace the prior
    // row instead of appending a duplicate so the session policy wins.
    modelPolicies: [
      override,
      ...config.modelPolicies.filter(item => (
        item.provider !== target.provider || item.model !== target.model
      )),
    ],
  }
}

/**
 * Install once after the official compaction provider is available.
 *
 * The provider has one mutable config object, hence compaction calls are
 * serialized around a temporary config swap. Regular requests are unaffected;
 * only an actual compaction operation waits for another session's operation.
 */
export function installSessionCompactionPolicyBridge(ctx: Context): void {
  ctx.inject(['compaction'], (compactionCtx) => {
    const candidate = compactionCtx.compaction
    if (!isMutableProvider(candidate)) {
      ctx.logger.warn('mindspace-session-memory: RC8 compaction provider has no compatible policy surface')
      return
    }

    const provider = candidate
    const original = provider.compactIfNeeded.bind(provider)
    let tail: Promise<void> = Promise.resolve()

    provider.compactIfNeeded = async (agent, trigger, signal) => {
      const policy = foldCompactionPolicy(agent.session.events)
      // A user disabling auto-compaction must still allow DSH's explicit
      // context-overflow recovery, otherwise the active request cannot recover.
      if (trigger === 'pressure' && !policy.enabled) return null

      const previous = tail
      let release: (() => void) | undefined
      tail = new Promise<void>((resolve) => { release = resolve })
      await previous
      const previousConfig = provider.config
      provider.config = withSessionCompactionPolicy(previousConfig, routedTarget(agent), policy)
      try {
        return await original(agent, trigger, signal)
      } finally {
        provider.config = previousConfig
        release?.()
      }
    }

    compactionCtx.effect(() => {
      provider.compactIfNeeded = original
    }, 'mindspace-session-memory: session compaction policy bridge')
  })
}
