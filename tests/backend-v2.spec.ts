import { describe, expect, it } from 'vitest'
import {
  emptySessionMemory,
  foldSessionMemory,
  migrateLegacyDocument,
  normalizeSessionMemoryDocument,
} from '../src/memory/fold.ts'
import { mergeAssistantIdentity, mergeExtraction, parseExtraction } from '../src/memory/extraction.ts'
import type { LegacySessionMemoryDocumentV1 } from '../src/memory/domain.ts'
import type { ExtractionProposal } from '../src/memory/extraction.ts'
import type { SessionMemoryDocument } from '../src/memory/types.ts'

function proposal(overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  return {
    userProfile: { confirmed: '', inferred: '' },
    preferences: [],
    assistantInstructions: [],
    relationship: null,
    roleplayPreset: null,
    atoms: [{ text: '普通问候', disposition: 'skipped', section: null, reason: 'Not durable personalization.' }],
    ...overrides,
  }
}

function currentWithPreference(text: string): SessionMemoryDocument {
  return {
    ...emptySessionMemory(),
    revision: 4,
    preferences: [{
      id: 'stable-id', category: '饮食偏好', text, source: 'extracted', evidenceSeqs: [10],
    }],
  }
}

describe('V2 complete-state extraction', () => {
  it('adds an assistant nickname without silently enabling a disabled preset', () => {
    const preset = mergeAssistantIdentity(
      { enabled: false, text: '你是萧镜鸢。' },
      '官方外号是粉色小鲸鱼。',
    )
    expect(preset).toEqual({ enabled: false, text: '你是萧镜鸢。\n官方外号是粉色小鲸鱼。' })
    expect(mergeAssistantIdentity(preset, '官方外号是粉色小鲸鱼。')).toEqual(preset)
  })

  it('rejects a partial result without a complete atom coverage ledger', () => {
    expect(parseExtraction(JSON.stringify({
      userProfile: { confirmed: '', inferred: '' },
      preferences: [],
      assistantInstructions: [],
      relationship: null,
      roleplayPreset: null,
    }))).toBeUndefined()
    expect(parseExtraction(JSON.stringify({
      userProfile: { confirmed: '', inferred: '' },
      preferences: [],
      assistantInstructions: [],
      relationship: null,
      roleplayPreset: null,
      atoms: [{ text: '我喜欢苹果', disposition: 'handled', section: null, reason: 'missing target' }],
    }))).toBeUndefined()
  })

  it('rejects a profile beyond the deterministic 300-character budget', () => {
    expect(parseExtraction(JSON.stringify({
      userProfile: { confirmed: '甲'.repeat(301), inferred: '' },
      preferences: [],
      assistantInstructions: [],
      relationship: null,
      roleplayPreset: null,
      atoms: [{ text: 'profile', disposition: 'handled', section: 'userProfile', reason: 'explicit' }],
    }))).toBeUndefined()
  })

  it('persists a same-length conflict replacement and retains the stable card id', () => {
    const before = currentWithPreference('喜欢苹果')
    const result = mergeExtraction(before, proposal({
      preferences: [{ category: '饮食偏好', text: '喜欢香蕉' }],
      atoms: [{ text: '我改成喜欢香蕉', disposition: 'handled', section: 'preferences', reason: 'explicit correction' }],
    }), [22], 1_000)
    expect(result.document.preferences).toHaveLength(1)
    expect(result.document.preferences[0]).toMatchObject({ id: 'stable-id', text: '喜欢香蕉' })
    expect(result.document.revision).toBe(5)
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'replace', section: 'preferences', sourceSeqs: [22] }),
    ]))
  })

  it('folds a fourth proposed category into three cards without losing its text', () => {
    const result = mergeExtraction(emptySessionMemory(), proposal({
      preferences: [
        { category: '饮食', text: '喜欢水果' },
        { category: '技术', text: '偏好Rust' },
        { category: '审美', text: '喜欢暖色' },
        { category: '作息', text: '习惯晚睡' },
      ],
      atoms: [{ text: '四类偏好', disposition: 'handled', section: 'preferences', reason: 'all explicit' }],
    }), [30], 2_000)
    expect(result.document.preferences).toHaveLength(3)
    expect(result.document.preferences.map(item => `${item.category}${item.text}`).join('|')).toContain('作息')
    expect(result.document.preferences.map(item => item.text).join('|')).toContain('习惯晚睡')
  })

  it('records explicit skipped atoms without pretending a state mutation occurred', () => {
    const result = mergeExtraction(emptySessionMemory(), proposal({
      atoms: [{ text: '今天天气不错', disposition: 'skipped', section: null, reason: 'Temporary small talk.' }],
    }), [41], 3_000)
    expect(result.document.revision).toBe(0)
    expect(result.changes).toEqual([
      expect.objectContaining({ operation: 'skip', sourceSeqs: [41], reason: 'Temporary small talk.' }),
    ])
  })
})

describe('V1 replay migration', () => {
  const legacy: LegacySessionMemoryDocumentV1 = {
    version: 1,
    revision: 7,
    summaryOverride: 'This is deliberately not migrated into personalization.',
    preferences: [{ id: 'p1', text: '喜欢水果', source: 'user', evidenceSeqs: [1] }],
    userFacts: [{ id: 'f1', text: '25岁男性', source: 'extracted', evidenceSeqs: [2] }],
    assistantInstructions: [{ id: 'a1', text: '回答简洁', source: 'user', evidenceSeqs: [3] }],
    relationship: null,
    roleplayPreset: null,
    updatedAt: 9,
  }

  it('migrates facts into confirmed profile and retires summaryOverride', () => {
    const migrated = migrateLegacyDocument(legacy)
    expect(migrated.version).toBe(2)
    expect(migrated.userProfile).toMatchObject({ confirmed: '25岁男性', inferred: '', evidenceSeqs: [2] })
    expect(migrated.preferences[0]).toMatchObject({ id: 'p1', category: '综合偏好' })
    expect(migrated).not.toHaveProperty('summaryOverride')
  })

  it('merges repeated legacy fallback categories so the migrated document remains writable', () => {
    const migrated = migrateLegacyDocument({
      ...legacy,
      preferences: [
        { id: 'p1', text: '喜欢水果', source: 'user', evidenceSeqs: [1] },
        { id: 'p2', text: '喜欢无糖茶', source: 'user', evidenceSeqs: [4] },
      ],
    })
    expect(migrated.preferences).toHaveLength(1)
    expect(migrated.preferences[0]).toMatchObject({ id: 'p1', category: '综合偏好' })
    expect(migrated.preferences[0]?.text).toContain('喜欢水果')
    expect(migrated.preferences[0]?.text).toContain('无糖茶')
    expect(migrated.preferences[0]?.evidenceSeqs).toEqual([1, 4])
  })

  it('repairs duplicate categories persisted by an early V2 preview before the next write', () => {
    const repaired = normalizeSessionMemoryDocument({
      ...emptySessionMemory(),
      revision: 9,
      preferences: [
        { id: 'first', category: '综合偏好', text: '喜欢水果', source: 'user', evidenceSeqs: [1] },
        { id: 'second', category: ' 综合偏好 ', text: '喜欢无糖茶', source: 'extracted', evidenceSeqs: [2] },
      ],
    })
    expect(repaired.preferences).toHaveLength(1)
    expect(repaired.preferences[0]).toMatchObject({ id: 'first', category: '综合偏好', source: 'user' })
    expect(repaired.preferences[0]?.text).toBe('喜欢水果；喜欢无糖茶')
    expect(repaired.preferences[0]?.evidenceSeqs).toEqual([1, 2])
  })

  it('replays a legacy change event into a V2 public view', () => {
    const view = foldSessionMemory([{
      type: 'session-memory/change',
      seq: 8,
      data: { version: 1, operation: 'replace', document: legacy },
    } as never])
    expect(view.document.version).toBe(2)
    expect(view.document.revision).toBe(7)
    expect(view.memoryActivity).toEqual([])
  })
})
