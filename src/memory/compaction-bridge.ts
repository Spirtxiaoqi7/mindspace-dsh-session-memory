/**
 * Session-local policy adapter for the stock DSH 0.1.x compaction provider.
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
  compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: unknown): Promise<CompactionResult | null>
}

/** Public structural boundary; DSH 0.1.x's BasicCompactionEngine satisfies this shape. */
function isMutableProvider(value: unknown): value is MutableCompactionProvider {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<MutableCompactionProvider>
  return typeof candidate.compactIfNeeded === 'function'
    && typeof candidate.compactNow === 'function'
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
  contextWindow?: number,
): ProviderConfig {
  // Absolute retention is model-capacity dependent.  A policy that was valid
  // on one route can otherwise disable compaction after a model switch.  Keep
  // at most half of the trigger budget; without catalog data, use the same
  // capacity-independent ratio so every model remains valid.
  const safeRetainRatio = Math.min(0.16, policy.thresholdRatio / 2)
  const retention = contextWindow !== undefined && Number.isInteger(contextWindow) && contextWindow > 0
    ? { retainTokens: Math.min(policy.retainTokens, Math.floor(contextWindow * safeRetainRatio)), retainRatio: undefined }
    : { retainTokens: undefined, retainRatio: safeRetainRatio }
  const base: ProviderConfig = {
    ...config,
    thresholdRatio: policy.thresholdRatio,
    ...retention,
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
    ...retention,
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
 * Install once and bridge every compaction provider visible from an agent scope.
 *
 * DSH Web deliberately disables the host-plane compaction rows and mounts the
 * engine plus `/compact` inside the standing Agent preset. Looking up
 * `ctx.compaction` here therefore reaches the wrong service (or no service at
 * all). The live provider must be resolved through `agent.ctx` after preset
 * composition. A standing preset shares one provider between its sessions, so
 * calls are serialized around a temporary config swap.
 */
export function installSessionCompactionPolicyBridge(
  ctx: Context,
  policyFor: (agent: Agent) => ContextCompactionPolicy,
): void {
  type Patch = {
    readonly provider: MutableCompactionProvider
    readonly compactIfNeeded: MutableCompactionProvider['compactIfNeeded']
    readonly compactNow: MutableCompactionProvider['compactNow']
    readonly wrappedIfNeeded: MutableCompactionProvider['compactIfNeeded']
    readonly wrappedNow: MutableCompactionProvider['compactNow']
  }

  const patches = new Map<MutableCompactionProvider, Patch>()

  const ensureProvider = (agent: Agent): void => {
    const candidate = agent.ctx.get('compaction')
    if (!isMutableProvider(candidate) || patches.has(candidate)) return

    const provider = candidate
    const original = provider.compactIfNeeded
    const originalNow = provider.compactNow
    let tail: Promise<void> = Promise.resolve()

    const withPolicy = async <T>(agent: Agent, signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
      const policy = policyFor(agent)
      const previous = tail
      let release: (() => void) | undefined
      tail = new Promise<void>((resolve) => { release = resolve })
      await previous
      const previousConfig = provider.config
      const target = routedTarget(agent)
      let contextWindow: number | undefined
      if (target !== undefined) {
        const llm = agent.ctx.get('llm') as {
          resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
            readonly context?: { readonly contextWindow: number }
          }>
        } | undefined
        try {
          contextWindow = (await llm?.resolveModelInfo(target.provider, target.model, signal))?.context?.contextWindow
        } catch {
          // The ratio fallback below remains valid when catalog lookup is unavailable.
        }
      }
      provider.config = withSessionCompactionPolicy(previousConfig, target, policy, contextWindow)
      try {
        return await operation()
      } finally {
        provider.config = previousConfig
        release?.()
      }
    }

    const wrappedIfNeeded: MutableCompactionProvider['compactIfNeeded'] = async (agent, trigger, signal) => {
      const policy = policyFor(agent)
      // Disabling automatic compaction must still allow provider-confirmed
      // overflow recovery, otherwise the current request cannot recover.
      if (trigger === 'pressure' && !policy.enabled) return null
      return await withPolicy(agent, signal, () => original.call(provider, agent, trigger, signal))
    }
    const wrappedNow: MutableCompactionProvider['compactNow'] = async (agent, signal, sourceCommandId) => (
      await withPolicy(agent, signal, () => originalNow.call(provider, agent, signal, sourceCommandId))
    )

    provider.compactIfNeeded = wrappedIfNeeded
    provider.compactNow = wrappedNow
    patches.set(provider, { provider, compactIfNeeded: original, compactNow: originalNow, wrappedIfNeeded, wrappedNow })
  }

  // Covers hot reload with already-live roots and the normal cold-start path.
  for (const agent of ctx.agents.roots()) ensureProvider(agent)
  ctx.on('agent/created', ({ agent }) => { ensureProvider(agent) })
  // Defensive lazy attachment for an agent published by a nonstandard factory.
  ctx.on('agent/pre-step', ({ agent }, next) => {
    ensureProvider(agent)
    return next()
  })

  ctx.effect(() => () => {
    for (const patch of patches.values()) {
      if (patch.provider.compactIfNeeded === patch.wrappedIfNeeded) {
        patch.provider.compactIfNeeded = patch.compactIfNeeded
      }
      if (patch.provider.compactNow === patch.wrappedNow) patch.provider.compactNow = patch.compactNow
    }
    patches.clear()
  }, 'mindspace-session-memory: scoped compaction policy bridges')
}
