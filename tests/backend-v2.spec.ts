import { describe, expect, it } from 'vitest'
import { emptySessionMemory, foldSessionMemory, migrateLegacyDocument, normalizeSessionMemoryDocument } from '../src/memory/fold.ts'
import { mergeAssistantIdentity, mergeExtraction, parseExtraction, parseOverwriteReview } from '../src/memory/extraction.ts'
import { renderSessionMemory } from '../src/memory/render.ts'
import type { LegacySessionMemoryDocumentV1, LegacySessionMemoryDocumentV2 } from '../src/memory/domain.ts'
import type { ExtractionProposal } from '../src/memory/extraction.ts'
import type { SessionMemoryDocument } from '../src/memory/types.ts'

function proposal(overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  return {
    userProfile: { confirmed: '', pendingConfirmation: '' },
    preferences: [], assistantRequirements: [], relationship: null, roleplayPreset: null, atoms: [], ...overrides,
  }
}

function currentWithPreference(text: string): SessionMemoryDocument {
  return {
    ...emptySessionMemory(), revision: 4,
    preferences: [{ id: 'stable-id', category: '饮食偏好', text, source: 'extracted', evidenceSeqs: [10] }],
  }
}

describe('V3 governed memory', () => {
  it('parses only the complete V3 taxonomy', () => {
    expect(parseExtraction(JSON.stringify({
      userProfile: { confirmed: '25岁', pendingConfirmation: '可能从事硬件开发' },
      preferences: [{ category: '沟通', text: '喜欢直接的人' }],
      assistantRequirements: [{ category: '回答', text: '必须先说结论' }],
      relationship: { status: '朋友', context: '近期稳定互动' }, roleplayPreset: null, atoms: [],
    }))).toMatchObject({ userProfile: { confirmed: '25岁', pendingConfirmation: '可能从事硬件开发' } })
    expect(parseExtraction(JSON.stringify({
      userProfile: { confirmed: '', pendingConfirmation: '' }, preferences: [], assistantRequirements: [],
      relationship: null, roleplayPreset: null,
    }))).toBeUndefined()
  })

  it('keeps confirmed and pending user information separate', () => {
    const result = mergeExtraction(emptySessionMemory(), proposal({
      userProfile: { confirmed: '25岁', pendingConfirmation: '可能喜欢硬件' },
      atoms: [{ text: 'profile', disposition: 'handled', section: 'userProfile', reason: 'explicit and pending evidence' }],
    }), [7], 100)
    expect(result.document.userProfile).toEqual({
      confirmed: '25岁', pendingConfirmation: '可能喜欢硬件', confirmedEvidenceSeqs: [7], pendingEvidenceSeqs: [7],
    })
  })

  it('renders relationship as revisable context, not identity or mission', () => {
    const document: SessionMemoryDocument = {
      ...emptySessionMemory(), relationship: { status: '朋友', context: '近期稳定且互相信任', updatedAt: 100 },
    }
    const rendered = renderSessionMemory({ document, memoryActivity: [] })
    expect(rendered).toContain('- Status: 朋友')
    expect(rendered).toContain('not a permanent identity, mission, or obligation')
    expect(rendered).not.toContain('Your primary mission')
  })

  it('keeps an explicitly authored assistant nickname in roleplay', () => {
    const preset = mergeAssistantIdentity({ enabled: false, text: '你是萧镜鸢。' }, '官方外号是粉色小鲸鱼。')
    expect(preset).toEqual({ enabled: false, text: '你是萧镜鸢。\n官方外号是粉色小鲸鱼。' })
    expect(mergeAssistantIdentity(preset, '官方外号是粉色小鲸鱼。')).toEqual(preset)
  })

  it('preserves a stable card id during explicit correction', () => {
    const result = mergeExtraction(currentWithPreference('喜欢苹果'), proposal({
      preferences: [{ category: '饮食偏好', text: '喜欢香蕉' }],
      atoms: [{ text: '改成香蕉', disposition: 'handled', section: 'preferences', reason: 'explicit correction' }],
    }), [22], 1_000)
    expect(result.document.preferences[0]).toMatchObject({ id: 'stable-id', text: '喜欢香蕉' })
    expect(result.document.revision).toBe(5)
  })

  it('preserves a card when overwrite review rejects replacement', () => {
    const result = mergeExtraction(currentWithPreference('喜欢苹果'), proposal({
      preferences: [{ category: '饮食偏好', text: '喜欢香蕉' }],
    }), [23], 1_001, { overwriteApprovals: [{
      section: 'preferences', before: '饮食偏好：喜欢苹果', after: '饮食偏好：喜欢香蕉',
      approved: false, reason: 'No explicit correction.',
    }] })
    expect(result.document.preferences[0]).toMatchObject({ id: 'stable-id', text: '喜欢苹果' })
    expect(result.document.revision).toBe(4)
  })

  it('requires an exact overwrite decision', () => {
    const candidates = [{ section: 'preferences' as const, before: '饮食偏好：喜欢苹果', after: '饮食偏好：喜欢香蕉' }]
    expect(parseOverwriteReview(JSON.stringify({ decisions: [{ ...candidates[0], approved: true, reason: '明确纠正' }] }), candidates))
      .toMatchObject([{ approved: true }])
    expect(parseOverwriteReview(JSON.stringify({ decisions: [] }), candidates)).toBeUndefined()
  })

  it('consolidates a fourth preference into the three-card limit', () => {
    const result = mergeExtraction(emptySessionMemory(), proposal({ preferences: [
      { category: '饮食', text: '喜欢水果' }, { category: '技术', text: '偏好Rust' },
      { category: '审美', text: '喜欢暖色' }, { category: '作息', text: '习惯晚睡' },
    ] }), [30], 2_000)
    expect(result.document.preferences).toHaveLength(3)
    expect(JSON.stringify(result.document.preferences)).toContain('习惯晚睡')
  })

  it('records skipped small talk without advancing revision', () => {
    const result = mergeExtraction(emptySessionMemory(), proposal({
      atoms: [{ text: '今天天气不错', disposition: 'skipped', section: null, reason: 'Temporary small talk.' }],
    }), [41], 3_000)
    expect(result.document.revision).toBe(0)
    expect(result.changes).toEqual([expect.objectContaining({ operation: 'skip' })])
  })
})

describe('legacy migration', () => {
  const legacyV1: LegacySessionMemoryDocumentV1 = {
    version: 1, revision: 7, summaryOverride: 'not migrated',
    preferences: [{ id: 'p1', text: '喜欢水果', source: 'user', evidenceSeqs: [1] }],
    userFacts: [{ id: 'f1', text: '25岁', source: 'extracted', evidenceSeqs: [2] }],
    assistantInstructions: [{ id: 'a1', text: '回答简洁', source: 'user', evidenceSeqs: [3] }],
    relationship: { role: '伙伴', mission: '永远陪伴', guidance: '温和' }, roleplayPreset: null, updatedAt: 9,
  }

  it('migrates V1 without keeping a permanent mission', () => {
    const migrated = migrateLegacyDocument(legacyV1)
    expect(migrated.version).toBe(3)
    expect(migrated.userProfile).toMatchObject({ confirmed: '25岁', pendingConfirmation: '', confirmedEvidenceSeqs: [2] })
    expect(migrated.assistantRequirements[0]).toMatchObject({ category: '对AI的要求' })
    expect(migrated.relationship).toMatchObject({ status: '伙伴', context: expect.stringContaining('不构成永久使命') })
  })

  it('migrates V2 observations to pending confirmation', () => {
    const legacyV2: LegacySessionMemoryDocumentV2 = {
      version: 2, revision: 8,
      userProfile: { confirmed: '25岁', inferred: '可能喜欢硬件', evidenceSeqs: [2, 4] },
      preferences: [], assistantInstructions: [],
      relationship: { role: '朋友', mission: '陪伴', guidance: '' }, roleplayPreset: null, updatedAt: 10,
    }
    const view = foldSessionMemory([{ type: 'session-memory/change', seq: 9, data: {
      version: 2, operation: 'replace', document: legacyV2, changes: [],
    } } as never])
    expect(view.document.version).toBe(3)
    expect(view.document.userProfile.pendingConfirmation).toBe('可能喜欢硬件')
    expect(view.document.relationship?.context).toContain('不构成永久使命')
  })

  it('repairs duplicate categories before the next write', () => {
    const repaired = normalizeSessionMemoryDocument({ ...emptySessionMemory(), revision: 9, preferences: [
      { id: 'first', category: '综合偏好', text: '喜欢水果', source: 'user', evidenceSeqs: [1] },
      { id: 'second', category: ' 综合偏好 ', text: '喜欢无糖茶', source: 'extracted', evidenceSeqs: [2] },
    ] })
    expect(repaired.preferences).toHaveLength(1)
    expect(repaired.preferences[0]?.text).toBe('喜欢水果；喜欢无糖茶')
  })
})
