import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptySessionMemory } from '../src/memory/fold.ts'
import { applyMaintenance, maintenanceOutput, evidenceBatches, readMaintenanceJobs } from '../src/memory/maintenance.ts'
import { applyMemoryMutation } from '../src/memory/mutation.ts'

const evidence = [{ seq: 7, role: 'user', text: '以后项目都用 Python；我不再喝咖啡了' }]
describe('long-term maintenance independent of compaction summary', () => {
  it('resumes valid jobs alongside corrupt files without touching the corrupt evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mindspace-maintenance-'))
    const prefix = createHash('sha256').update('session').digest('hex')
    const broken = join(root, `${prefix}-broken.json`)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const valid = { id: 'job', sessionId: 'session', entries: evidence, state: 'pending', attempts: 0, error: '', createdAt: 1, updatedAt: 1 }
      await writeFile(broken, '{truncated')
      await writeFile(join(root, `${prefix}-valid.json`), JSON.stringify(valid))
      await writeFile(join(root, `${prefix}-foreign.json`), JSON.stringify({ ...valid, sessionId: 'other' }))
      expect(readMaintenanceJobs(root, 'session')).toEqual([valid])
      expect(await readFile(broken, 'utf8')).toBe('{truncated')
      expect(warning).toHaveBeenCalledTimes(2)
    } finally { warning.mockRestore(); await rm(root, { recursive: true, force: true }) }
  })
  it('processes long raw conversations in order without dropping evidence', () => {
    const entries = [{ seq: 1, role: 'user', text: '甲'.repeat(70_000) }, { seq: 2, role: 'assistant', text: '乙'.repeat(3000) }]
    const batches = evidenceBatches(entries)
    expect(batches).toHaveLength(3)
    expect(batches.flat().map(row => row.text).join('')).toBe(entries.map(row => row.text).join(''))
    expect(batches.flat().map(row => row.seq)).toEqual([1, 1, 1, 2])
    expect(evidenceBatches([])).toEqual([])
  })
  it('preserves old valid facts when no changes are proposed', () => {
    const doc = emptySessionMemory()
    expect(applyMaintenance(doc, { operations: [] }, evidence)).toEqual(doc)
  })
  it('stages work facts during chat without writing across modes', () => {
    const doc = emptySessionMemory()
    const next = applyMaintenance(doc, maintenanceOutput.parse({ operations: [{ mode: 'work', action: 'upsert_item', section: 'memories', category: '语言', text: '项目使用Python', evidence: [7], reason: '用户明确要求' }] }), evidence)
    expect(next.work).toEqual(doc.work)
    expect(next.bridge.pendingWrites).toHaveLength(1)
    expect(doc.bridge.pendingWrites).toHaveLength(0)
  })
  it('marks extracted facts with real evidence, not as direct user edits', () => {
    const doc = emptySessionMemory()
    const next = applyMaintenance(doc, maintenanceOutput.parse({ operations: [{ mode: 'chat', action: 'upsert_item', section: 'memories', category: '饮食', text: '不再喝咖啡', evidence: [7], reason: '用户纠正' }] }), evidence)
    expect(next.chat.memories[0]?.source).toBe('extracted')
    expect(next.chat.memories[0]?.evidenceSeqs).toEqual([7])
  })
  it('rejects invented evidence without modifying source memory', () => {
    const doc = emptySessionMemory()
    expect(() => applyMaintenance(doc, maintenanceOutput.parse({ operations: [{ mode: 'chat', action: 'set_assistant_state', assistant_state: 'unknown', evidence: [99], reason: 'unknown' }] }), evidence)).toThrow('evidence')
    expect(doc.chat.assistantState).toBe('')
  })
  it('never evicts the shortest fact when adding a fourth card', () => {
    let mode = emptySessionMemory().chat
    for (let n = 0; n < 4; n++) mode = applyMemoryMutation(mode, { action: 'upsert_item', section: 'memories', category: `c${n}`, text: n ? 'a longer fact' : '短' }, [7])
    expect(mode.memories).toHaveLength(4)
    expect(mode.memories[0]?.text).toBe('短')
  })
})
