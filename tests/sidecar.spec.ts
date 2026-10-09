import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionMemorySidecar } from '../src/memory/sidecar.ts'

const homes: string[] = []
const originalHome = process.env.DSH_HOME

afterEach(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('SessionMemorySidecar', () => {
  it.each(['{truncated', JSON.stringify({ format: 99, sessionId: 'broken' }), JSON.stringify({ format: 5, sessionId: 'broken', view: {}, compactionPolicy: {} })])('preserves unreadable memory instead of overwriting it with empty history (%s)', async contents => {
    const home = await mkdtemp(join(tmpdir(), 'mindspace-memory-sidecar-'))
    homes.push(home)
    process.env.DSH_HOME = home
    const root = join(home, 'mindspace-session-memory', 'v1')
    await mkdir(root, { recursive: true })
    const file = join(root, `${createHash('sha256').update('broken').digest('hex')}.json`)
    await writeFile(file, contents)
    const store = new SessionMemorySidecar()
    const session = { id: 'broken', events: [] } as never
    expect(() => store.read(session)).toThrow('原文件已保留')
    expect(() => store.replace(session, { document: {} as never, memoryActivity: [] })).toThrow('原文件已保留')
    expect(await readFile(file, 'utf8')).toBe(contents)
  })

  it('persists memory outside the canonical session event log', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mindspace-memory-sidecar-'))
    homes.push(home)
    process.env.DSH_HOME = home
    const session = { id: 'sidecar-a', events: [] } as never
    const store = new SessionMemorySidecar()
    const initial = store.read(session)
    const view = {
      ...initial.view,
      document: {
        ...initial.view.document,
        revision: 1,
        chat: { ...initial.view.document.chat, people: [{ id: 'person-1', name: '人物一', information: 'confirmed person fact', preference: '', relationship: '', source: 'user', evidenceSeqs: [], updatedAt: 1 }] },
        updatedAt: 1,
      },
    }

    store.replace(session, view)

    expect(session.events).toEqual([])
    expect(new SessionMemorySidecar().read(session).view).toEqual(view)
  })

  it('keeps sidecars session-isolated', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mindspace-memory-sidecar-'))
    homes.push(home)
    process.env.DSH_HOME = home
    const first = { id: 'sidecar-first', events: [] } as never
    const second = { id: 'sidecar-second', events: [] } as never
    const store = new SessionMemorySidecar()
    const firstView = store.read(first).view
    store.replace(first, {
      ...firstView,
      document: { ...firstView.document, revision: 1, updatedAt: 1, chat: { ...firstView.document.chat, people: [{ id: 'p1', name: '甲', information: '', preference: '', relationship: '协作伙伴；共同规划', source: 'user', evidenceSeqs: [], updatedAt: 1 }] } },
    })

    expect(store.read(second).view.document.chat.people).toEqual([])
  })

  it('imports the earliest memory-center event vocabulary once', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mindspace-memory-sidecar-'))
    homes.push(home)
    process.env.DSH_HOME = home
    const session = {
      id: 'legacy-memory',
      events: [
        { type: 'memory/set', seq: 1, time: 1, data: { version: 1, slot: 'preferences', id: 'tea', text: 'likes tea', source: 'user' } },
        { type: 'memory/relationship', seq: 2, time: 2, data: { version: 1, role: 'partner', mission: 'keep continuity', personaText: 'warm and direct' } },
      ],
    } as never

    const view = new SessionMemorySidecar().read(session).view

    expect(view.document.chat.people[0]).toMatchObject({
      name: '人物一', preference: expect.stringContaining('likes tea'),
      relationship: expect.stringContaining('partner'),
    })
  })
})
