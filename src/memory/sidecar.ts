/** Durable per-session storage outside DSH's canonical conversation event log. */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  emptySessionMemory,
  foldCompactionPolicy,
  foldSessionMemory,
  migrateV4Document,
  migrateV2Document,
  migrateV3Document,
  normalizeCompactionPolicy,
} from './fold.ts'
import type { LegacySessionMemoryDocumentV2, LegacySessionMemoryDocumentV3, LegacySessionMemoryDocumentV4, LegacySessionMemoryItem } from './domain.ts'
import type { ContextCompactionPolicy, SessionMemoryActivity, SessionMemoryView } from './types.ts'

export interface StoredSessionMemory {
  readonly format: 5
  readonly sessionId: string
  readonly view: SessionMemoryView
  readonly compactionPolicy: ContextCompactionPolicy
  readonly writtenAt: number
}

interface LegacyStoredSessionMemoryV4 {
  readonly format: 4
  readonly sessionId: string
  readonly view: { readonly document: LegacySessionMemoryDocumentV4; readonly memoryActivity: readonly unknown[] }
  readonly compactionPolicy: ContextCompactionPolicy
  readonly writtenAt: number
}

interface LegacyStoredSessionMemoryV3 {
  readonly format: 3
  readonly sessionId: string
  readonly view: { readonly document: LegacySessionMemoryDocumentV3; readonly memoryActivity: readonly unknown[] }
  readonly compactionPolicy: ContextCompactionPolicy
  readonly writtenAt: number
}

interface LegacyStoredSessionMemoryV2 {
  readonly format: 2
  readonly sessionId: string
  readonly view: { readonly document: LegacySessionMemoryDocumentV2; readonly memoryActivity: readonly unknown[] }
  readonly compactionPolicy: ContextCompactionPolicy
  readonly writtenAt: number
}

function dshHome(): string { return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh') }
function sessionFilename(id: string): string { return `${createHash('sha256').update(id).digest('hex')}.json` }

function storedBase(value: unknown, sessionId: string, format: number): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return row['format'] === format && row['sessionId'] === sessionId
    && row['view'] !== null && typeof row['view'] === 'object'
    && row['compactionPolicy'] !== null && typeof row['compactionPolicy'] === 'object'
}

function isStored(value: unknown, sessionId: string): value is StoredSessionMemory { return storedBase(value, sessionId, 5) }
function isStoredV4(value: unknown, sessionId: string): value is LegacyStoredSessionMemoryV4 { return storedBase(value, sessionId, 4) }
function isStoredV3(value: unknown, sessionId: string): value is LegacyStoredSessionMemoryV3 { return storedBase(value, sessionId, 3) }
function isStoredV2(value: unknown, sessionId: string): value is LegacyStoredSessionMemoryV2 { return storedBase(value, sessionId, 2) }

function migrateActivity(value: unknown): SessionMemoryActivity | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const oldSection = String(row['section'] ?? '')
  const section: SessionMemoryActivity['section'] = oldSection === 'assistantRequirements' || oldSection === 'assistantInstructions'
    ? 'assistantRequirements' : oldSection === 'roleplayPreset' ? 'memories' : 'people'
  return { ...(row as unknown as SessionMemoryActivity), section, mode: row['mode'] === 'work' ? 'work' : 'chat' }
}

type LegacyMemoryEvent = { readonly type: string; readonly seq: number; readonly data: Record<string, unknown> }

function legacyMemoryView(events: readonly unknown[]): { readonly view: SessionMemoryView; readonly lastSeq: number } {
  const preferences: LegacySessionMemoryItem[] = []
  const requirements: LegacySessionMemoryItem[] = []
  let relationship: LegacySessionMemoryDocumentV3['relationship'] = null
  let lastSeq = -1
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue
    const event = raw as Partial<LegacyMemoryEvent>
    if (typeof event.type !== 'string' || !event.type.startsWith('memory/') || event.data === null || typeof event.data !== 'object') continue
    const data = event.data
    lastSeq = typeof event.seq === 'number' ? event.seq : lastSeq
    if (event.type === 'memory/set') {
      const slot = data.slot
      const target = slot === 'preferences' ? preferences : slot === 'instructions' ? requirements : undefined
      const text = typeof data.text === 'string' ? data.text.trim() : ''
      if (target === undefined || text === '') continue
      const id = typeof data.id === 'string' && data.id.trim() ? data.id : `legacy-${slot}-${lastSeq}`
      const next: LegacySessionMemoryItem = {
        id,
        category: typeof data.category === 'string' && data.category.trim() ? data.category : slot === 'preferences' ? '综合偏好' : '对AI的要求',
        text,
        source: data.source === 'extracted' ? 'extracted' : 'user',
        evidenceSeqs: typeof data.evidenceSeq === 'number' ? [data.evidenceSeq] : [],
      }
      const at = target.findIndex(item => item.id === id)
      if (at >= 0) target.splice(at, 1, next)
      else target.push(next)
    } else if (event.type === 'memory/remove' && typeof data.id === 'string') {
      const target = data.slot === 'preferences' ? preferences : data.slot === 'instructions' ? requirements : undefined
      if (target !== undefined) {
        const at = target.findIndex(item => item.id === data.id)
        if (at >= 0) target.splice(at, 1)
      }
    } else if (event.type === 'memory/relationship') {
      const status = typeof data.role === 'string' ? data.role.trim() : ''
      if (status) relationship = {
        status,
        context: [
          typeof data.personaText === 'string' ? data.personaText.trim() : '',
          typeof data.mission === 'string' && data.mission.trim() ? `历史背景：${data.mission.trim()}` : '',
        ].filter(Boolean).join('；'),
        updatedAt: Date.now(),
      }
    }
  }
  if (lastSeq < 0) return { view: { document: emptySessionMemory(), memoryActivity: [] }, lastSeq }
  const document = migrateV3Document({
    version: 3, revision: 1,
    userProfile: { confirmed: '', pendingConfirmation: '', confirmedEvidenceSeqs: [], pendingEvidenceSeqs: [] },
    preferences, assistantRequirements: requirements, relationship, roleplayPreset: null, updatedAt: Date.now(),
  })
  return { view: { document, memoryActivity: [] }, lastSeq }
}

function importedView(session: Session): SessionMemoryView {
  const modern = foldSessionMemory(session.events)
  const modernSeq = session.events.findLast(event => event.type === 'session-memory/change')?.seq ?? -1
  const legacy = legacyMemoryView(session.events)
  return legacy.lastSeq > modernSeq ? legacy.view : modern
}

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
          const stored = { ...parsed, compactionPolicy: normalizeCompactionPolicy(parsed.compactionPolicy) }
          this.cache.set(session.id, stored)
          return stored
        }
        if (isStoredV4(parsed, session.id) || isStoredV3(parsed, session.id) || isStoredV2(parsed, session.id)) {
          const document = parsed.format === 4 ? migrateV4Document(parsed.view.document) : parsed.format === 3 ? migrateV3Document(parsed.view.document) : migrateV2Document(parsed.view.document)
          const migrated: StoredSessionMemory = {
            format: 5, sessionId: session.id,
            view: { document, memoryActivity: parsed.view.memoryActivity.map(migrateActivity).filter((item): item is SessionMemoryActivity => item !== undefined) },
            compactionPolicy: normalizeCompactionPolicy(parsed.compactionPolicy), writtenAt: Date.now(),
          }
          this.write(migrated)
          return migrated
        }
      } catch {
        // A valid conversation fold below can still restore visible state.
      }
    }
    const imported: StoredSessionMemory = {
      format: 5, sessionId: session.id, view: importedView(session),
      compactionPolicy: foldCompactionPolicy(session.events), writtenAt: Date.now(),
    }
    this.write(imported)
    return imported
  }

  replace(session: Session, view: SessionMemoryView): StoredSessionMemory {
    const next: StoredSessionMemory = { ...this.read(session), view, writtenAt: Date.now() }
    this.write(next)
    return next
  }

  setPolicy(session: Session, policy: ContextCompactionPolicy): StoredSessionMemory {
    const next: StoredSessionMemory = { ...this.read(session), compactionPolicy: normalizeCompactionPolicy(policy), writtenAt: Date.now() }
    this.write(next)
    return next
  }

  private pathFor(sessionId: string): string { return join(this.root, sessionFilename(sessionId)) }

  private write(value: StoredSessionMemory): void {
    mkdirSync(this.root, { recursive: true })
    const target = this.pathFor(value.sessionId)
    const temporary = join(this.root, `.${sessionFilename(value.sessionId)}.${randomUUID()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, target)
    this.cache.set(value.sessionId, value)
  }
}
