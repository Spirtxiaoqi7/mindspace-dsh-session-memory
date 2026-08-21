import { describe, expect, it } from 'vitest'
import { visibleSessionIds, visibleSessionSelection } from '../src/client/visible-sessions.ts'

describe('Memory Center session visibility', () => {
  it('excludes archived conversations from the editable-memory selector', () => {
    const visible = visibleSessionIds(
      ['active', 'archived', 'other'],
      ['active', 'archived', 'other'],
      ['archived'],
      true,
    )
    expect(visible).toEqual(['active', 'other'])
    expect(visibleSessionSelection('archived', 'archived', visible)).toBe('active')
  })

  it('keeps a current live conversation selected and has a safe empty state', () => {
    const visible = visibleSessionIds(['older', 'current'], ['older', 'current'], [], true)
    expect(visibleSessionSelection(undefined, 'current', visible)).toBe('current')
    expect(visibleSessionSelection('gone', undefined, [])).toBeUndefined()
  })

  it('fails closed until the workspace and session archive baselines are ready', () => {
    expect(visibleSessionIds(['active', 'archived'], ['active', 'archived'], [], false)).toEqual([])
    expect(visibleSessionIds(['active', 'archived'], ['active', 'archived'], ['archived'], true)).toEqual(['active'])
  })

  it('excludes subagent and legacy sessions that do not belong to a workspace', () => {
    expect(visibleSessionIds(
      ['top-level', 'subagent', 'orphan'],
      ['top-level'],
      [],
      true,
    )).toEqual(['top-level'])
  })
})
