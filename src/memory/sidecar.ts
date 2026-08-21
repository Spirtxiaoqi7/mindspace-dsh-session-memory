/**
 * Durable per-session storage outside DSH's canonical conversation event log.
 *
 * RC8 deliberately has no registration surface for third-party session event
 * types.  A plugin must therefore never use `Session.append()` as its durable
 * store: unknown event envelopes make a later stock DSH replay refuse the
 * complete conversation.  This small sidecar store imports the legacy fold on
 * first access, then owns all subsequent personalization and policy writes.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { emptySessionMemory, foldCompactionPolicy, foldSessionMemory, normalizeCompactionPolicy, normalizeSessionMemoryDocument } from './fold.ts'
import type { ContextCompactionPolicy, SessionMemoryDocument, SessionMemoryItem, SessionMemoryView } from './types.ts'

export interface StoredSessionMemory {
  /** Bumped when the legacy import rules change. */
  readonly format: 2
  readonly sessionId: string
  readonly view: SessionMemoryView
  readonly compactionPolicy: ContextCompactionPolicy
  readonly writtenAt: number
}

function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

function sessionFilename(id: string): string {
  return `${createHash('sha256').update(id).digest('hex')}.json`
}

function isStored(value: unknown, sessionId: string): value is StoredSessionMemory {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<StoredSessionMemory>
  return item.format === 2 && item.sessionId === sessionId
    && item.view !== undefined && typeof item.view === 'object'
    && item.compactionPolicy !== undefined && typeof item.compactionPolicy === 'object'
}

type LegacyMemoryEvent = { readonly type: string; readonly seq: number; readonly data: Record<string, unknown> }

function legacyMemoryView(events: readonly unknown[]): { readonly view: SessionMemoryView; readonly lastSeq: number } {
  let document: SessionMemoryDocument = emptySessionMemory()
  let lastSeq = -1
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue
    const event = raw as Partial<LegacyMemoryEvent>
    if (typeof event.type !== 'string' || !event.type.startsWith('memory/') || event.data === null || typeof event.data !== 'object') continue
    const data = event.data
    lastSeq = typeof event.seq === 'number' ? event.seq : lastSeq
    if (event.type === 'memory/set') {
      const slot = data.slot
      const text = typeof data.text === 'string' ? data.text.trim() : ''
      if ((slot !== 'preferences' && slot !== 'instructions') || text.length === 0) continue
      const section = slot === 'preferences' ? 'preferences' : 'assistantInstructions'
      const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id : `legacy-${section}-${lastSeq}`
      const item: SessionMemoryItem = {
        id,
        category: typeof data.category === 'string' && data.category.trim().length > 0
          ? data.category : slot === 'preferences' ? '综合偏好' : '交互要求',
        text,
        source: data.source === 'extracted' ? 'extracted' : 'user',
        evidenceSeqs: typeof data.evidenceSeq === 'number' ? [data.evidenceSeq] : [],
      }
      const existing = document[section].filter(value => value.id !== id)
      document = { ...document, [section]: [...existing, item], revision: Math.max(document.revision, 1), updatedAt: Date.now() }
    } else if (event.type === 'memory/remove') {
      const section = data.slot === 'preferences' ? 'preferences' : data.slot === 'instructions' ? 'assistantInstructions' : undefined
      if (section === undefined || typeof data.id !== 'string') continue
      document = { ...document, [section]: document[section].filter(value => value.id !== data.id), revision: Math.max(document.revision, 1), updatedAt: Date.now() }
    } else if (event.type === 'memory/relationship') {
      const role = typeof data.role === 'string' ? data.role.trim() : ''
      if (role.length === 0) continue
      document = {
        ...document,
        relationship: {
          role,
          mission: typeof data.mission === 'string' ? data.mission : '',
          guidance: typeof data.personaText === 'string' ? data.personaText : '',
        },
        revision: Math.max(document.revision, 1),
        updatedAt: Date.now(),
      }
    }
  }
  return { view: { document: normalizeSessionMemoryDocument(document), memoryActivity: [] }, lastSeq }
}

function importedView(session: Session): SessionMemoryView {
  const modern = foldSessionMemory(session.events)
  const modernSeq = session.events.findLast(event => event.type === 'session-memory/change')?.seq ?? -1
  const legacy = legacyMemoryView(session.events)
  return legacy.lastSeq > modernSeq ? legacy.view : modern
}

/** Synchronous, tiny JSON cache: prompt assembly must remain synchronous. */
export class SessionMemorySidecar {
  private readonly root = join(dshHome(), 'mindspace-session-memory', 'v1')
  private readonly cache = new Map<string, StoredSessionMemory>()

  read(session: Session): StoredSessionMemory {
    const cached = this.cache.get(session.id)
    if (cached !== undefined) return cached
    const path = this.pathFor(session.id)
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (isStored(parsed, session.id)) {
          const stored: StoredSessionMemory = {
            ...parsed,
            compactionPolicy: normalizeCompactionPolicy(parsed.compactionPolicy),
          }
          this.cache.set(session.id, stored)
          return stored
        }
      } catch {
        // Keep the malformed sidecar untouched; a valid legacy fold below can
        // still restore the visible document and will write a fresh artifact.
      }
    }
    const imported: StoredSessionMemory = {
      format: 2,
      sessionId: session.id,
      view: importedView(session),
      compactionPolicy: foldCompactionPolicy(session.events),
      writtenAt: Date.now(),
    }
    this.write(imported)
    return imported
  }

  replace(session: Session, view: SessionMemoryView): StoredSessionMemory {
    const current = this.read(session)
    const next: StoredSessionMemory = { ...current, view, writtenAt: Date.now() }
    this.write(next)
    return next
  }

  setPolicy(session: Session, policy: ContextCompactionPolicy): StoredSessionMemory {
    const current = this.read(session)
    const next: StoredSessionMemory = {
      ...current,
      compactionPolicy: normalizeCompactionPolicy(policy),
      writtenAt: Date.now(),
    }
    this.write(next)
    return next
  }

  private pathFor(sessionId: string): string {
    return join(this.root, sessionFilename(sessionId))
  }

  private write(value: StoredSessionMemory): void {
    mkdirSync(this.root, { recursive: true })
    const target = this.pathFor(value.sessionId)
    const temporary = join(this.root, `.${sessionFilename(value.sessionId)}.${randomUUID()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, target)
    this.cache.set(value.sessionId, value)
  }
}
