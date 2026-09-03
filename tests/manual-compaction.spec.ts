import { describe, expect, it, vi } from 'vitest'
import { executeManualCompaction, type CommandsRemote } from '../src/client/SessionMemorySection.tsx'

describe('manual compaction command compatibility', () => {
  it('uses the stock /compact command and reports its settled result', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, value: { result: { kind: 'success' as const, text: 'Compacted 12 history items.' } } }))
    const message = await executeManualCompaction({ execute } as CommandsRemote, 'session-test' as never)
    expect(execute).toHaveBeenCalledWith('session-test', '/compact', [])
    expect(message).toBe('Compacted 12 history items.')
  })

  it('preserves a stock command failure instead of claiming success', async () => {
    const commands = { execute: vi.fn(async () => ({ ok: true as const, value: { result: { kind: 'error' as const, text: 'agent is busy' } } })) } as CommandsRemote
    await expect(executeManualCompaction(commands, 'session-test' as never)).resolves.toBe('agent is busy')
  })
})
