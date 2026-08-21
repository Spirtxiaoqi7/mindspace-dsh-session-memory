import { mkdtemp, rm } from 'node:fs/promises'
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
        userProfile: { confirmed: 'confirmed user fact', inferred: '', evidenceSeqs: [] },
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
      document: { ...firstView.document, revision: 1, updatedAt: 1, relationship: { role: 'planner', mission: 'plan', guidance: '' } },
    })

    expect(store.read(second).view.document.relationship).toBeNull()
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

    expect(view.document.preferences).toMatchObject([{ id: 'tea', text: 'likes tea' }])
    expect(view.document.relationship).toEqual({ role: 'partner', mission: 'keep continuity', guidance: 'warm and direct' })
  })
})
