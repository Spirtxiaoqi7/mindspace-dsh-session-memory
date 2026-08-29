import { describe, expect, it } from 'vitest'
import { emptySessionMemory, foldSessionMemory, migrateLegacyDocument } from '../src/memory/fold.ts'
import { mergeExtraction, parseExtraction, parseOverwriteReview } from '../src/memory/extraction.ts'
import { renderAssistantRequirements, renderSessionMemory, renderSessionMemoryContext } from '../src/memory/render.ts'
import type { LegacySessionMemoryDocumentV1, LegacySessionMemoryDocumentV2, LegacySessionMemoryDocumentV3 } from '../src/memory/domain.ts'
import type { ExtractionProposal } from '../src/memory/extraction.ts'

const proposal = (value: Partial<ExtractionProposal> = {}): ExtractionProposal => ({ people: [], assistantRequirements: [], memories: [], atoms: [], ...value })

describe('V4 multi-person memory', () => {
  it('parses a complete multi-person proposal and rejects a sixth person', () => {
    const row = { name: '柒君', information: '25岁', preference: '喜欢硬件', relationship: '朋友' }
    expect(parseExtraction(JSON.stringify({ people: [row], assistantRequirements: [], memories: [], atoms: [] })))?.toMatchObject({ people: [{ name: '柒君' }] })
    expect(parseExtraction(JSON.stringify({ people: Array.from({ length: 6 }, () => row), assistantRequirements: [], memories: [], atoms: [] }))).toBeUndefined()
  })

  it('keeps person id stable while updating information and preference', () => {
    const current = { ...emptySessionMemory(), revision: 4, people: [{ id: 'stable-person', name: '柒君', information: '25岁', preference: '喜欢苹果', relationship: '朋友', source: 'user' as const, evidenceSeqs: [1], updatedAt: 1 }] }
    const next = mergeExtraction(current, proposal({ people: [{ id: 'stable-person', name: '柒君', information: '25岁', preference: '喜欢香蕉', relationship: '朋友' }] }), [2], 10)
    expect(next.document.people[0]).toMatchObject({ id: 'stable-person', preference: '喜欢香蕉' })
    expect(next.document.revision).toBe(5)
  })

  it('allows same-name people because identity is id-based', () => {
    const next = mergeExtraction(emptySessionMemory(), proposal({ people: [
      { name: '小明', information: '甲', preference: '', relationship: '' },
      { name: '小明', information: '乙', preference: '', relationship: '' },
    ] }), [3], 11)
    expect(next.document.people).toHaveLength(2)
    expect(next.document.people[0]?.id).not.toBe(next.document.people[1]?.id)
  })

  it('renders Chinese prompt fields without a single-user declaration', () => {
    const current = { ...emptySessionMemory(), people: [{ id: 'p1', name: '柒君', information: '25岁', preference: '喜欢直接沟通', relationship: '朋友', source: 'user' as const, evidenceSeqs: [], updatedAt: 1 }] }
    const text = renderSessionMemory({ document: current, memoryActivity: [] })
    expect(text).toContain('人物一')
    expect(text).toContain('个体名称：柒君')
    expect(text).toContain('人物偏好：喜欢直接沟通')
    expect(text).not.toContain('single user')
  })

  it('uses AI requirements as persona and leaves an empty document prompt-free', () => {
    const empty = { document: emptySessionMemory(), memoryActivity: [] }
    expect(renderAssistantRequirements(empty)).toBe('')
    expect(renderSessionMemoryContext(empty)).toBe('')
    expect(renderSessionMemory(empty)).toBe('')

    const document = {
      ...emptySessionMemory(),
      assistantRequirements: [{ id: 'r1', category: '身份', text: '你叫镜鸢', source: 'user' as const, evidenceSeqs: [], updatedAt: 1 }],
      memories: [{ id: 'm1', category: '经历', text: '一起看过海', source: 'user' as const, evidenceSeqs: [], updatedAt: 1 }],
    }
    const view = { document, memoryActivity: [] }
    expect(renderAssistantRequirements(view)).toBe('对 AI 的要求：\n- 身份：你叫镜鸢')
    expect(renderSessionMemoryContext(view)).toBe('记忆：\n- 经历：一起看过海')
    expect(renderSessionMemoryContext(view)).not.toContain('你叫镜鸢')
  })

  it('requires exact overwrite decisions for people', () => {
    const candidates = [{ section: 'people' as const, before: '{"name":"甲"}', after: '{"name":"乙"}' }]
    expect(parseOverwriteReview(JSON.stringify({ decisions: [{ ...candidates[0], approved: true, reason: '明确纠正' }] }), candidates)).toMatchObject([{ approved: true }])
    expect(parseOverwriteReview(JSON.stringify({ decisions: [] }), candidates)).toBeUndefined()
  })

  it('keeps requirements and ordinary memories as separate three-card lists', () => {
    const next = mergeExtraction(emptySessionMemory(), proposal({ assistantRequirements: [{ category: '回答', text: '先说结论' }], memories: [{ category: '经历', text: '完成了硬件调试' }] }), [4], 12)
    expect(next.document.assistantRequirements[0]?.text).toBe('先说结论')
    expect(next.document.memories[0]?.text).toBe('完成了硬件调试')
  })

  it('records skipped small talk without advancing revision', () => {
    const result = mergeExtraction(emptySessionMemory(), proposal({ atoms: [{ text: '天气不错', disposition: 'skipped', section: null, reason: '临时闲聊' }] }), [5], 13)
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
    relationship: { role: '伙伴', mission: '共同研究', guidance: '温和' }, roleplayPreset: { enabled: true, text: '旧扮演内容' }, updatedAt: 9,
  }
  it('migrates V1 into person one, requirements, and ordinary memory', () => {
    const migrated = migrateLegacyDocument(legacyV1)
    expect(migrated.version).toBe(4)
    expect(migrated.people[0]).toMatchObject({ name: '人物一', information: '25岁', preference: expect.stringContaining('喜欢水果'), relationship: expect.stringContaining('伙伴') })
    expect(migrated.assistantRequirements[0]).toMatchObject({ category: '对AI的要求' })
    expect(migrated.memories[0]?.text).toBe('旧扮演内容')
  })

  it('migrates V2 observed information into person one without loss', () => {
    const legacyV2: LegacySessionMemoryDocumentV2 = { version: 2, revision: 8, userProfile: { confirmed: '25岁', inferred: '可能喜欢硬件', evidenceSeqs: [2, 4] }, preferences: [], assistantInstructions: [], relationship: null, roleplayPreset: null, updatedAt: 10 }
    const view = foldSessionMemory([{ type: 'session-memory/change', seq: 9, data: { version: 2, operation: 'replace', document: legacyV2, changes: [] } } as never])
    expect(view.document.people[0]?.information).toBe('25岁；可能喜欢硬件')
  })

  it('preserves pre-existing over-300 V3 data during migration', () => {
    const legacy: LegacySessionMemoryDocumentV3 = { version: 3, revision: 9, userProfile: { confirmed: '甲'.repeat(350), pendingConfirmation: '', confirmedEvidenceSeqs: [], pendingEvidenceSeqs: [] }, preferences: [], assistantRequirements: [], relationship: null, roleplayPreset: null, updatedAt: 11 }
    const view = foldSessionMemory([{ type: 'session-memory/change', seq: 10, data: { version: 3, operation: 'replace', document: legacy, changes: [] } } as never])
    expect(view.document.people[0]?.information).toHaveLength(350)
    expect(view.document.people[0]?.updatedAt).toBe(-1)
  })
})
