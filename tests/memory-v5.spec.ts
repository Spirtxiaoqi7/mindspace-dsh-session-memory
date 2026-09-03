import { describe, expect, it } from 'vitest'
import { needsAssistantStateReminder } from '../src/memory/state-reminder.ts'
import { emptySessionMemory, foldSessionMemory, migrateLegacyDocument, migrateV4Document } from '../src/memory/fold.ts'
import { modelSessionMemorySnapshot, renderAssistantRequirements, renderBridge, renderSessionMemory, renderSessionMemoryContext } from '../src/memory/render.ts'
import { applyMemoryMutation } from '../src/memory/mutation.ts'
import type { LegacySessionMemoryDocumentV1, LegacySessionMemoryDocumentV2, LegacySessionMemoryDocumentV3, LegacySessionMemoryDocumentV4 } from '../src/memory/domain.ts'

describe('V5 task-conditioned memory', () => {
  it('renders only the active face and keeps tools explicitly unaffected', () => {
    const document = {
      ...emptySessionMemory(),
      activeMode: 'chat' as const,
      chat: { ...emptySessionMemory().chat, assistantSetting: '日常陪伴者', assistantState: '穿蓝色外套', memories: [{ id: 'c1', category: '日常', text: '一起看过海', source: 'user' as const, evidenceSeqs: [] }] },
      work: { ...emptySessionMemory().work, assistantSetting: '工程搭档', memories: [{ id: 'w1', category: '工作偏好', text: '喜欢 Python', source: 'user' as const, evidenceSeqs: [] }] },
    }
    const text = renderSessionMemoryContext({ document, memoryActivity: [] })
    expect(text).toContain('Chat（日常）')
    expect(text).toContain('不限制任何工具或行为')
    expect(text).toContain('必须在本轮调用 update_session_memory')
    expect(text).toContain('一起看过海')
    expect(text).not.toContain('喜欢 Python')
  })

  it('makes a confirmed current outfit a direct one-call memory action', () => {
    const current = emptySessionMemory().chat
    const next = applyMemoryMutation(current, {
      action: 'set_assistant_state',
      assistant_state: '白衬衫、黑色包臀裙和丝袜',
    }, [42])
    expect(next.assistantState).toBe('白衬衫、黑色包臀裙和丝袜')
  })

  it('places a state-write reminder next to appearance corrections but not unrelated chat', () => {
    const user = (text: string) => ({ content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `user-${text}` })
    expect(needsAssistantStateReminder([user('可以啊，那你换这身')])).toBe(true)
    expect(needsAssistantStateReminder([user('你的外观没变化')])).toBe(true)
    expect(needsAssistantStateReminder([user('今天吃什么？')])).toBe(false)
  })

  it('gives the model a compact authoritative snapshot without audit history', () => {
    const document = { ...emptySessionMemory(), chat: { ...emptySessionMemory().chat, assistantState: '白衬衫' } }
    const snapshot = modelSessionMemorySnapshot({ document, memoryActivity: [{ id: 'large-audit', sourceSeqs: [], operation: 'replace', section: 'assistantState', mode: 'chat', before: '', after: '白衬衫', reason: 'test', at: 1 }] })
    expect(snapshot.activeMode).toBe('chat')
    expect(snapshot.memory.assistantState).toBe('白衬衫')
    expect(snapshot).not.toHaveProperty('memoryActivity')
    expect(snapshot).not.toHaveProperty('work')
  })

  it('separates AI requirements from ordinary memory in both modes', () => {
    const document = {
      ...emptySessionMemory(),
      activeMode: 'work' as const,
      work: {
        ...emptySessionMemory().work,
        assistantRequirements: [{ id: 'r1', category: '表达', text: '先说结论', source: 'user' as const, evidenceSeqs: [] }],
        memories: [{ id: 'm1', category: '项目', text: '正在维护插件', source: 'user' as const, evidenceSeqs: [] }],
      },
    }
    const view = { document, memoryActivity: [] }
    expect(renderAssistantRequirements(view)).toBe('对 AI 的要求：\n- 表达：先说结论')
    expect(renderSessionMemoryContext(view)).toContain('正在维护插件')
    expect(renderSessionMemoryContext(view)).not.toContain('先说结论')
  })

  it('renders the bridge as transition plus pending writes, not hidden memory', () => {
    const document = {
      ...emptySessionMemory(),
      bridge: {
        transitionNote: '从 Chat 转到 Work，上一段停在旅行安排。',
        pendingWrites: [{ id: 'p1', fromMode: 'chat' as const, targetMode: 'work' as const, instruction: '写入工作偏好：Python', suggestedAction: 'upsert_item' as const, suggestedSection: 'memories' as const, sourceSeqs: [8], createdAt: 9 }],
      },
    }
    const text = renderBridge({ document, memoryActivity: [] })
    expect(text).toContain('最近转场')
    expect(text).toContain('p1 -> work')
  })

  it('leaves an empty document free of invented people and facts', () => {
    const view = { document: emptySessionMemory(), memoryActivity: [] }
    expect(renderAssistantRequirements(view)).toBe('')
    expect(renderSessionMemoryContext(view)).toContain('当前记忆模式：Chat（日常）')
    expect(renderSessionMemory(view)).not.toContain('人物一')
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

  it('preserves V1 business data in Chat and leaves Work empty', () => {
    const migrated = migrateLegacyDocument(legacyV1)
    expect(migrated.version).toBe(5)
    expect(migrated.activeMode).toBe('chat')
    expect(migrated.chat.people[0]).toMatchObject({ information: '25岁', preference: expect.stringContaining('喜欢水果'), relationship: expect.stringContaining('伙伴') })
    expect(migrated.chat.assistantRequirements[0]).toMatchObject({ category: '对AI的要求' })
    expect(migrated.chat.memories[0]?.text).toBe('旧扮演内容')
    expect(migrated.work.people).toEqual([])
  })

  it('preserves V2 inferred information and over-300 V3 profile text', () => {
    const legacyV2: LegacySessionMemoryDocumentV2 = { version: 2, revision: 8, userProfile: { confirmed: '25岁', inferred: '可能喜欢硬件', evidenceSeqs: [2, 4] }, preferences: [], assistantInstructions: [], relationship: null, roleplayPreset: null, updatedAt: 10 }
    const v2 = foldSessionMemory([{ type: 'session-memory/change', seq: 9, data: { version: 2, operation: 'replace', document: legacyV2, changes: [] } } as never])
    expect(v2.document.chat.people[0]?.information).toBe('25岁；可能喜欢硬件')

    const legacyV3: LegacySessionMemoryDocumentV3 = { version: 3, revision: 9, userProfile: { confirmed: '甲'.repeat(350), pendingConfirmation: '', confirmedEvidenceSeqs: [], pendingEvidenceSeqs: [] }, preferences: [], assistantRequirements: [], relationship: null, roleplayPreset: null, updatedAt: 11 }
    const v3 = foldSessionMemory([{ type: 'session-memory/change', seq: 10, data: { version: 3, operation: 'replace', document: legacyV3, changes: [] } } as never])
    expect(v3.document.chat.people[0]?.information).toHaveLength(350)
    expect(v3.document.chat.people[0]?.updatedAt).toBe(-1)
  })

  it('moves every V4 field into Chat without copying it to Work', () => {
    const legacy: LegacySessionMemoryDocumentV4 = { version: 4, revision: 12, people: [{ id: 'p', name: '柒君', information: '用户', preference: '直接沟通', relationship: '伙伴', source: 'user', evidenceSeqs: [1], updatedAt: 2 }], assistantRequirements: [], memories: [], updatedAt: 3 }
    const migrated = migrateV4Document(legacy)
    expect(migrated.chat.people[0]?.name).toBe('柒君')
    expect(migrated.work.people).toEqual([])
    expect(migrated.bridge.transitionNote).toContain('preserved in Chat')
  })
})
