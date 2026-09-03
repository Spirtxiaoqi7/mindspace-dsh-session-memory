/** Chat/Work memory editor and composer mode control. */
import { useEffect, useMemo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextCompactionPolicy, ContextCompactionStatus, ReplaceSessionMemoryRequest, SessionMemoryItem, SessionMemoryMode, SessionMemoryMutationResult, SessionMemoryView, SessionModeMemory, SessionPerson } from '../memory/types.ts'
import type { SessionMemoryKey } from './locales.ts'
import { visibleSessionIds, visibleSessionSelection } from './visible-sessions.ts'
import css from './SessionMemorySection.module.css'

const DEFAULT_POLICY: ContextCompactionPolicy = { enabled: true, thresholdRatio: 0.164, retainTokens: 64_000, maxTokens: 6_000, updatedAt: 0 }
type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
export interface SessionMemoryRemote {
  get(agentId: never): Promise<RemoteResult<SessionMemoryView>>
  replace(agentId: never, request: ReplaceSessionMemoryRequest): Promise<RemoteResult<SessionMemoryMutationResult>>
  getCompactionPolicy(agentId: never): Promise<RemoteResult<ContextCompactionPolicy>>
  getCompactionStatus(agentId: never): Promise<RemoteResult<ContextCompactionStatus>>
  setCompactionPolicy(agentId: never, policy: ContextCompactionPolicy): Promise<RemoteResult<ContextCompactionPolicy>>
}
export interface CommandsRemote { execute(agentId: never, line: string, images: readonly never[]): Promise<RemoteResult<{ readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | undefined>> }
export async function executeManualCompaction(commands: CommandsRemote, agentId: never): Promise<string> {
  const response = await commands.execute(agentId, '/compact', [])
  if (!response.ok) return response.error.message
  if (response.value === undefined) return '当前会话没有可用的 /compact 命令。'
  return response.value.result.text ?? (response.value.result.kind === 'success' ? '主动压缩已完成。' : '主动压缩未执行。')
}
export interface SessionMemorySectionInjected { remote: SessionMemoryRemote; commands?: CommandsRemote; t: (key: SessionMemoryKey) => string }
export type SessionMemorySectionProps = PropsRuntime<'settings.section'> & Partial<SessionMemorySectionInjected>
interface Draft { expectedRevision: number; activeMode: SessionMemoryMode; modeSource: 'user' | 'model' | 'migration'; modeReason: string; chat: SessionModeMemory; work: SessionModeMemory; bridge: SessionMemoryView['document']['bridge']; policy: ContextCompactionPolicy }

const card = (): SessionMemoryItem => ({ id: `draft-${crypto.randomUUID()}`, category: '', text: '', source: 'user', evidenceSeqs: [] })
const person = (index: number): SessionPerson => ({ id: `draft-person-${crypto.randomUUID()}`, name: `人物${index + 1}`, information: '', preference: '', relationship: '', source: 'user', evidenceSeqs: [], updatedAt: Date.now() })
const request = (draft: Draft): ReplaceSessionMemoryRequest => ({ expectedRevision: draft.expectedRevision, activeMode: draft.activeMode, modeSource: draft.modeSource, modeReason: draft.modeReason, chat: draft.chat, work: draft.work, bridge: draft.bridge })

function Cards({ title, items, onChange }: { title: string; items: readonly SessionMemoryItem[]; onChange: (items: SessionMemoryItem[]) => void }) {
  return <section className={css.subcard}><div className={css.cardTitle}><h4>{title}</h4><span className={css.limitBadge}>{items.length}/3</span></div>
    {items.map((item, index) => <div className={css.memoryCard} key={item.id}><div className={css.memoryCardHeader}><span>归纳组 {index + 1}</span><button type="button" onClick={() => onChange(items.filter(row => row.id !== item.id))}>删除</button></div><input value={item.category} placeholder="分类" onChange={event => onChange(items.map(row => row.id === item.id ? { ...row, category: event.target.value } : row))}/><textarea rows={3} value={item.text} placeholder="归纳后的完整内容" onChange={event => onChange(items.map(row => row.id === item.id ? { ...row, text: event.target.value } : row))}/></div>)}
    <button className={css.addGroupButton} type="button" disabled={items.length >= 3} onClick={() => onChange([...items, card()])}>新增归纳组</button></section>
}

function ModeEditor({ mode, value, onChange }: { mode: SessionMemoryMode; value: SessionModeMemory; onChange: (value: SessionModeMemory) => void }) {
  const label = mode === 'chat' ? 'Chat · 日常' : 'Work · 工作'
  const updatePerson = (index: number, patch: Partial<SessionPerson>) => onChange({ ...value, people: value.people.map((row, at) => at === index ? { ...row, ...patch, source: 'user', updatedAt: Date.now() } : row) })
  return <div className={css.modePanel}><div className={css.modeHeading}><div><h3>{label}</h3><p>{mode === 'chat' ? '日常关系、偏好、长期经历与当前衣着。' : '项目、工程状态、协作关系与工作要求。'}</p></div><span>{value.people.length}/5 人物</span></div>
    <section className={css.subcard}><label><span>AI 设定</span><textarea rows={3} value={value.assistantSetting} onChange={event => onChange({ ...value, assistantSetting: event.target.value })}/></label><label><span>{mode === 'chat' ? 'AI 当前衣着与外观' : 'AI 当前工作角色与状态'}</span><textarea rows={2} value={value.assistantState} onChange={event => onChange({ ...value, assistantState: event.target.value })}/></label></section>
    <section className={css.subcard}><div className={css.cardTitle}><h4>{mode === 'chat' ? '日常人物' : '工作人物'}</h4><button type="button" disabled={value.people.length >= 5} onClick={() => onChange({ ...value, people: [...value.people, person(value.people.length)] })}>新增人物</button></div>{value.people.map((row, index) => <article className={css.memoryCard} key={row.id}><div className={css.memoryCardHeader}><strong>人物 {index + 1}</strong><button type="button" onClick={() => onChange({ ...value, people: value.people.filter(item => item.id !== row.id) })}>删除</button></div><label><span>名称</span><input value={row.name} onChange={event => updatePerson(index, { name: event.target.value })}/></label><label><span>{mode === 'chat' ? '日常信息' : '工作信息'}</span><textarea rows={3} value={row.information} onChange={event => updatePerson(index, { information: [...event.target.value].slice(0, 300).join('') })}/></label><label><span>{mode === 'chat' ? '日常偏好' : '工作偏好'}</span><textarea rows={2} value={row.preference} onChange={event => updatePerson(index, { preference: [...event.target.value].slice(0, 300).join('') })}/></label><label><span>{mode === 'chat' ? '与 AI 的关系' : '协作关系'}</span><textarea rows={2} value={row.relationship} onChange={event => updatePerson(index, { relationship: event.target.value })}/></label></article>)}</section>
    <Cards title="对 AI 的要求" items={value.assistantRequirements} onChange={assistantRequirements => onChange({ ...value, assistantRequirements })}/>
    <Cards title={mode === 'chat' ? '长期日常记忆' : '长期工作记忆'} items={value.memories} onChange={memories => onChange({ ...value, memories })}/>
  </div>
}

export function MemoryModeChip({ session, remote }: PropsRuntime<'conversation.input.left'> & { remote: SessionMemoryRemote }) {
  const [view, setView] = useState<SessionMemoryView>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const id = session.sessionId as never
  const load = async () => { const result = await remote.get(id); if (result.ok) { setView(result.value); setError('') } else setError(result.error.message) }
  useEffect(() => {
    let active = true
    const refresh = async () => { const result = await remote.get(id); if (!active) return; if (result.ok) { setView(result.value); setError('') } else setError(result.error.message) }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => { active = false; window.clearInterval(timer) }
  }, [session.sessionId])
  if (!view) return null
  const mode = view.document.activeMode; const pending = view.document.bridge.pendingWrites.filter(item => item.targetMode === mode).length
  const toggle = async () => {
    setBusy(true); setError('')
    const latest = await remote.get(id)
    if (!latest.ok) { setError(latest.error.message); setBusy(false); return }
    const doc = latest.value.document; const target = doc.activeMode === 'chat' ? 'work' : 'chat'
    const result = await remote.replace(id, { expectedRevision: doc.revision, activeMode: target, modeSource: 'user', modeReason: '用户从输入框切换模式', chat: doc.chat, work: doc.work, bridge: { ...doc.bridge, transitionNote: `${doc.activeMode} → ${target}：用户手动切换。` } })
    if (result.ok && result.value.ok) setView(result.value.value)
    else setError(result.ok ? result.value.error.message : result.error.message)
    setBusy(false)
  }
  const title = error ? `模式切换失败：${error}` : '切换 Chat / Work；模型仍会根据当前语义判断是否需要调整'
  return <button type="button" className={`${css.modeChip} ${mode === 'work' ? css.modeChipWork : ''} ${error ? css.modeChipError : ''}`} disabled={busy} onClick={() => void toggle()} title={title} aria-label={`${mode === 'chat' ? 'Chat' : 'Work'} 记忆模式${pending ? `，${pending} 条待处理` : ''}`}><span className={css.modeDot}/><strong>{busy ? '切换中' : mode === 'chat' ? 'Chat' : 'Work'}</strong>{pending > 0 && <span className={css.pendingBadge}>{pending}</span>}</button>
}

const tokens = (value: number | null): string => value === null ? '未知' : Math.round(value).toLocaleString('zh-CN')

export function SessionMemorySection({ useSessions, useWorkspaces, remote, commands, t }: SessionMemorySectionProps) {
  if (!remote || !t) return null
  const sessions = useSessions(state => state); const workspaces = useWorkspaces(state => state)
  const [selectedId, setSelectedId] = useState<string | undefined>(sessions.current ?? sessions.ids[0]); const [view, setView] = useState<SessionMemoryView>(); const [draft, setDraft] = useState<Draft>(); const [compaction, setCompaction] = useState<ContextCompactionStatus>(); const [tab, setTab] = useState<SessionMemoryMode>('chat'); const [status, setStatus] = useState('')
  const visible = useMemo(() => visibleSessionIds(sessions.ids, workspaces.items.flatMap(row => row.sessionIds), workspaces.archivedSessionIds, workspaces.baselinesReady), [sessions.ids, workspaces.items, workspaces.archivedSessionIds, workspaces.baselinesReady])
  const selected = visibleSessionSelection(selectedId, sessions.current, visible); const options = visible.map(id => sessions.byId[id]).filter(Boolean)
  const loadCompaction = async () => { if (!selected) return; const result = await remote.getCompactionStatus(selected as never); if (result.ok) setCompaction(result.value) }
  const load = async () => { if (!selected) return; setStatus('正在读取…'); const result = await remote.get(selected as never); if (!result.ok) { setStatus(result.error.message); return } let policy = DEFAULT_POLICY; const p = await remote.getCompactionPolicy(selected as never); if (p.ok) policy = p.value; const doc = result.value.document; setView(result.value); setDraft({ ...doc, expectedRevision: doc.revision, policy }); setTab(doc.activeMode); await loadCompaction(); setStatus('') }
  useEffect(() => { void load() }, [selected])
  if (!workspaces.baselinesReady) return <div className={css.section}>正在读取会话…</div>
  const applyPolicy = async () => { if (!draft || !selected) return; setStatus('正在应用压缩设置…'); const result = await remote.setCompactionPolicy(selected as never, draft.policy); if (!result.ok) { setStatus(result.error.message); return } setDraft({ ...draft, policy: result.value }); await loadCompaction(); setStatus('压缩设置已应用') }
  const save = async () => { if (!draft || !selected) return; setStatus('正在保存…'); const result = await remote.replace(selected as never, request(draft)); if (!result.ok || !result.value.ok) { setStatus(result.ok ? result.value.error.message : result.error.message); return } const policy = await remote.setCompactionPolicy(selected as never, draft.policy); if (!policy.ok) { setStatus(`记忆已保存；压缩设置失败：${policy.error.message}`); return } setView(result.value.value); setDraft({ ...draft, expectedRevision: result.value.value.document.revision, policy: policy.value }); await loadCompaction(); setStatus('已保存') }
  return <div className={css.section}><header><h2>记忆中心</h2><p>同一个人、同一个 AI，按当前任务载入 Chat 或 Work。模式不限制工具，只隔离记忆与写入目标。</p></header><label className={css.sessionSelect}><span>会话</span><select value={selected} onChange={event => { setSelectedId(event.target.value); setView(undefined); setDraft(undefined) }}>{options.map(row => <option key={row!.id} value={row!.id}>{row!.displayTitle}</option>)}</select></label>
    {draft && <><div className={css.modeTabs}><button className={tab === 'chat' ? css.activeTab : ''} onClick={() => setTab('chat')}>Chat</button><button className={tab === 'work' ? css.activeTab : ''} onClick={() => setTab('work')}>Work</button><span>当前注入：{draft.activeMode === 'chat' ? 'Chat' : 'Work'} · {draft.modeSource === 'model' ? '模型判断' : draft.modeSource === 'user' ? '用户选择' : '迁移默认'}</span></div><ModeEditor mode={tab} value={draft[tab]} onChange={value => setDraft({ ...draft, [tab]: value })}/>
      <section className={css.card}><div className={css.cardTitle}><div><h3>中立桥接层</h3><p>只保存转场说明和跨域待写项，不保存两边的详细记忆。</p></div><span className={css.limitBadge}>{draft.bridge.pendingWrites.length} 待处理</span></div><label><span>转场说明（最多 300 字）</span><textarea rows={3} value={draft.bridge.transitionNote} onChange={event => setDraft({ ...draft, bridge: { ...draft.bridge, transitionNote: [...event.target.value].slice(0, 300).join('') } })}/></label>{draft.bridge.pendingWrites.map(row => <div className={css.pendingRow} key={row.id}><strong>{row.fromMode} → {row.targetMode}</strong><span>{row.instruction}</span></div>)}</section>
      <section className={css.card} data-context-compaction><div className={css.cardTitle}><div><h3>上下文压缩</h3><p>每次模型执行前自动检查；只压缩较早对话，Chat / Work 记忆不进入摘要。</p></div><label className={css.switch}><input type="checkbox" checked={draft.policy.enabled} onChange={event => setDraft({ ...draft, policy: { ...draft.policy, enabled: event.target.checked } })}/><span>{draft.policy.enabled ? '自动已启用' : '自动已关闭'}</span></label></div>
        {compaction && <div className={css.compactionStatus}><strong>{compaction.state === 'due' ? '已达到触发线，将在下一步自动压缩' : compaction.state === 'waiting' ? '自动压缩正常等待中' : compaction.state === 'disabled' ? '自动压缩已关闭' : '当前模型无法读取上下文容量'}</strong><span>当前估算 {tokens(compaction.estimatedTokens)} / 触发线 {tokens(compaction.thresholdTokens)} tokens</span><span>模型上下文 {tokens(compaction.contextWindow)} · 实际保留 {tokens(compaction.effectiveRetainTokens)} tokens</span>{compaction.lastCompaction && <span>最近一次：{compaction.lastCompaction.kind === 'automatic' ? '自动' : '手动'} · {compaction.lastCompaction.status === 'completed' ? '完成' : compaction.lastCompaction.status === 'running' ? '进行中' : `失败：${compaction.lastCompaction.error}`} · {new Date(compaction.lastCompaction.at).toLocaleString()}</span>}</div>}
        <div className={css.twoColumn}><label><span>达到上下文比例时触发 %</span><input type="number" min="5" max="80" step="0.1" value={Number((draft.policy.thresholdRatio * 100).toFixed(1))} onChange={event => setDraft({ ...draft, policy: { ...draft.policy, thresholdRatio: Number(event.target.value) / 100 } })}/></label><label><span>希望保留末尾原文 tokens</span><input type="number" min="4096" step="1024" value={draft.policy.retainTokens} onChange={event => setDraft({ ...draft, policy: { ...draft.policy, retainTokens: Math.max(4096, Number(event.target.value) || 4096) } })}/></label><label><span>摘要上限 tokens</span><input type="number" min="512" max="8192" step="256" value={draft.policy.maxTokens} onChange={event => setDraft({ ...draft, policy: { ...draft.policy, maxTokens: Math.min(8192, Math.max(512, Number(event.target.value) || 512)) } })}/></label></div>
        <div className={css.compactionActions}><button type="button" onClick={() => void applyPolicy()}>应用压缩设置</button><button type="button" disabled={commands === undefined} onClick={async () => { if (!commands || selected === undefined) return; setStatus('正在压缩当前会话…'); setStatus(await executeManualCompaction(commands, selected as never)); await loadCompaction() }}>立即压缩当前会话</button><button type="button" onClick={() => void loadCompaction()}>刷新状态</button></div>
      </section>
      <footer className={css.footer}><span>{status || `修订 ${view?.document.revision ?? 0}`}</span><button onClick={() => void load()}>重新载入</button><button className={css.primary} onClick={() => void save()}>保存</button></footer></>}
  </div>
}
