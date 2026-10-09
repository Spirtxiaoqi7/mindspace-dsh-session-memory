import { describe, expect, it, vi } from 'vitest'
import { currentSessionId, openMemorySession } from '../src/client/navigation.ts'

describe('session navigation across DSH versions', () => {
  it('finds the viewed 0.2 session rather than the first catalog row', () => {
    expect(currentSessionId({ byId: { first: { id: 'first', retainedBy: {} }, viewed: { id: 'viewed', retainedBy: { mainView: 1 } } } })).toBe('viewed')
    expect(currentSessionId({ byId: {} })).toBeUndefined()
  })
  it('retains the 0.1 selection and opening interface', () => {
    expect(currentSessionId({ current: 'legacy', byId: {} })).toBe('legacy')
    const open = vi.fn()
    openMemorySession('legacy', undefined, { open })
    expect(open).toHaveBeenCalledWith('legacy')
  })
  it('uses workspace-owned navigation on 0.2 and reports missing capabilities', () => {
    const openSession = vi.fn(), oldOpen = vi.fn()
    openMemorySession('new', { openSession }, { open: oldOpen })
    expect(openSession).toHaveBeenCalledWith('new')
    expect(oldOpen).not.toHaveBeenCalled()
    expect(() => openMemorySession('new', undefined, {})).toThrow('从侧栏打开')
  })
})
