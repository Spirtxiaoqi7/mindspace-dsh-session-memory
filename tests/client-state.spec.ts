import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryModeChip, SessionMemorySection } from '../src/client/SessionMemorySection.tsx'
import { emptySessionMemory } from '../src/memory/fold.ts'

const mounted: ReactTestRenderer[] = []
const policy = { enabled: true, thresholdRatio: 0.164, retainTokens: 64000, maxTokens: 6000, updatedAt: 0 }
const pressure = { enabled: true, state: 'waiting', estimatedTokens: 0, contextWindow: 128000, thresholdTokens: 20992, effectiveRetainTokens: 64000, utilizationRatio: 0, lastCompaction: null }
const view = (setting: string) => {
  const document = emptySessionMemory()
  return { document: { ...document, chat: { ...document.chat, assistantSetting: setting } }, memoryActivity: [] }
}
const remoteFor = (get: ReturnType<typeof vi.fn>) => ({
  get,
  getCompactionPolicy: vi.fn(async () => ({ ok: true, value: policy })),
  getCompactionStatus: vi.fn(async () => ({ ok: true, value: pressure })),
  setCompactionPolicy: vi.fn(async () => ({ ok: true, value: policy })),
  replace: vi.fn(async () => ({ ok: true, value: { ok: true, value: view('B') } })),
})
const sectionProps = (remote: ReturnType<typeof remoteFor>) => ({
  remote,
  t: (key: string) => key,
  useSessions: (select: (state: unknown) => unknown) => select({ ids: ['a', 'b'], byId: { a: { id: 'a', displayTitle: 'A', retainedBy: { mainView: 1 } }, b: { id: 'b', displayTitle: 'B', retainedBy: {} } } }),
  useWorkspaces: (select: (state: unknown) => unknown) => select({ phase: 'ready', items: [{ sessionIds: ['a', 'b'] }], archivedSessionIds: [] }),
})
afterEach(() => {
  act(() => { for (const renderer of mounted.splice(0)) renderer.unmount() })
  vi.unstubAllGlobals()
})

describe('memory UI failure and session isolation', () => {
  it('never loads a late session A response into session B or saves A as B', async () => {
    let resolveA!: (value: unknown) => void
    const pendingA = new Promise(resolve => { resolveA = resolve })
    const remote = remoteFor(vi.fn(id => id === 'a' ? pendingA : Promise.resolve({ ok: true, value: view('B') })))
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(SessionMemorySection, sectionProps(remote) as never)); mounted.push(renderer) })
    await act(async () => { renderer.root.findByType('select').props.onChange({ target: { value: 'b' } }) })
    await act(async () => { resolveA({ ok: true, value: view('A') }) })
    expect(renderer.root.findAllByType('textarea').map(node => node.props.value)).toContain('B')
    expect(renderer.root.findAllByType('textarea').map(node => node.props.value)).not.toContain('A')
    await act(async () => { renderer.root.findAllByType('button').find(node => node.props.children === '保存')!.props.onClick() })
    expect(remote.replace).toHaveBeenCalledWith('b', expect.objectContaining({ chat: expect.objectContaining({ assistantSetting: 'B' }) }))
  })

  it('shows policy failures and prevents saving an invented default policy', async () => {
    const remote = remoteFor(vi.fn(async () => ({ ok: true, value: view('A') })))
    remote.getCompactionPolicy.mockResolvedValue({ ok: false, error: { message: 'policy offline' } } as never)
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(SessionMemorySection, sectionProps(remote) as never)); mounted.push(renderer) })
    expect(JSON.stringify(renderer.toJSON())).toContain('policy offline')
    expect(renderer.root.findAllByType('button').some(node => node.props.children === '保存')).toBe(false)
  })

  it('renders a retry control when the first composer memory read rejects', async () => {
    vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn() })
    const remote = remoteFor(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, value: view('A') }))
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(MemoryModeChip, { sessionId: 'a', remote } as never)); mounted.push(renderer) })
    expect(JSON.stringify(renderer.toJSON())).toContain('记忆读取失败')
    await act(async () => { renderer.root.findByType('button').props.onClick() })
    expect(JSON.stringify(renderer.toJSON())).toContain('Chat')
  })
})
