/** Multi-person memory editor for one selected session. */
import { useEffect, useMemo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextCompactionPolicy, ReplaceSessionMemoryRequest, SessionMemoryActivity, SessionMemoryItem, SessionMemoryMutationResult, SessionMemoryView, SessionPerson } from '../memory/types.ts'
import type { SessionMemoryKey } from './locales.ts'
import { visibleSessionIds, visibleSessionSelection } from './visible-sessions.ts'
import css from './SessionMemorySection.module.css'

const DEFAULT_COMPACTION_POLICY: ContextCompactionPolicy = { enabled: true, thresholdRatio: 0.164, retainTokens: 64_000, maxTokens: 6_000, updatedAt: 0 }
type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
interface SessionMemoryRemote {
  get(agentId: never): Promise<RemoteResult<SessionMemoryView>>
  replace(agentId: never, request: ReplaceSessionMemoryRequest): Promise<RemoteResult<SessionMemoryMutationResult>>
  getCompactionPolicy(agentId: never): Promise<RemoteResult<ContextCompactionPolicy>>
  setCompactionPolicy(agentId: never, policy: ContextCompactionPolicy): Promise<RemoteResult<ContextCompactionPolicy>>
}
export interface CommandsRemote { execute(agentId: never, line: string, images: readonly never[]): Promise<RemoteResult<{ readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | undefined>> }
export async function executeManualCompaction(commands: CommandsRemote, agentId: never): Promise<string> {
  const response = await commands.execute(agentId, '/compact', [])
  if (!response.ok) return response.error.message
  if (response.value === undefined) return '当前会话没有可用的 /compact 命令。'
  return response.value.result.kind === 'success' ? (response.value.result.text ?? '主动压缩已完成。') : (response.value.result.text ?? '主动压缩未执行。')
}
export interface SessionMemorySectionInjected { remote: SessionMemoryRemote; commands?: CommandsRemote; t: (key: SessionMemoryKey) => string }
export type SessionMemorySectionProps = PropsRuntime<'settings.section'> & Partial<SessionMemorySectionInjected>
interface EditableDocument { expectedRevision: number; people: SessionPerson[]; assistantRequirements: SessionMemoryItem[]; memories: SessionMemoryItem[]; compactionPolicy: ContextCompactionPolicy }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function mergeDraftOverLatest(draft: EditableDocument, baseline: SessionMemoryView['document'], latest: SessionMemoryView['document']): ReplaceSessionMemoryRequest {
  return { expectedRevision: latest.revision, people: same(draft.people, baseline.people) ? latest.people : draft.people,
    assistantRequirements: same(draft.assistantRequirements, baseline.assistantRequirements) ? latest.assistantRequirements : draft.assistantRequirements,
    memories: same(draft.memories, baseline.memories) ? latest.memories : draft.memories }
}
function card(): SessionMemoryItem { return { id: `draft-${crypto.randomUUID()}`, category: '', text: '', source: 'user', evidenceSeqs: [] } }
function person(index: number): SessionPerson { return { id: `draft-person-${crypto.randomUUID()}`, name: `人物${index + 1}`, information: '', preference: '', relationship: '', source: 'user', evidenceSeqs: [], updatedAt: Date.now() } }

function StructuredItemEditor({ title, hint, items, onChange, t }: { title: string; hint: string; items: readonly SessionMemoryItem[]; onChange: (items: SessionMemoryItem[]) => void; t: SessionMemorySectionInjected['t'] }) {
  const visible = items.slice(0, 3)
  return <section className={css.card}><div className={css.cardTitle}><div><h3>{title}</h3><p>{hint}</p></div><span className={css.limitBadge}>{visible.length}/3</span></div>
    <div className={css.structuredGrid}>{visible.map((entry, index) => <article className={css.memoryCard} key={entry.id}>
      <div className={css.memoryCardHeader}><span>{t('group')} {index + 1}</span><button type="button" onClick={() => onChange(visible.filter(value => value.id !== entry.id))}>{t('remove')}</button></div>
      <input className={css.categoryInput} value={entry.category} placeholder={t('categoryPlaceholder')} onChange={event => onChange(visible.map((value, at) => at === index ? { ...value, category: event.target.value, source: 'user' } : value))} />
      <textarea rows={3} value={entry.text} placeholder={t('structuredPlaceholder')} onChange={event => onChange(visible.map((value, at) => at === index ? { ...value, text: event.target.value, source: 'user' } : value))} />
    </article>)}</div><button className={css.addGroupButton} type="button" disabled={visible.length >= 3} onClick={() => onChange([...visible, card()])}>{visible.length >= 3 ? t('groupLimit') : t('addGroup')}</button>
  </section>
}

function Activity({ records, t }: { records: readonly SessionMemoryActivity[]; t: SessionMemorySectionInjected['t'] }) {
  const labels = { append: t('activityAppend'), merge: t('activityMerge'), replace: t('activityReplace'), skip: t('activitySkip') }
  const sections: Record<SessionMemoryActivity['section'], string> = { people: t('people'), assistantRequirements: t('instructions'), memories: t('memories') }
  return <section className={css.card}><div className={css.cardTitle}><div><h3>{t('activity')}</h3><p>{t('activityHint')}</p></div></div>
    {records.length === 0 ? <div className={css.emptyState}>{t('noActivity')}</div> : <div className={css.activityList}>{records.slice(-12).reverse().map(record => <article className={css.activityRow} key={record.id}>
      <div className={css.activityMeta}><span className={`${css.operation} ${css[record.operation]}`}>{labels[record.operation]}</span><strong>{sections[record.section]}</strong>{record.sourceSeqs.length > 0 && <span>#{record.sourceSeqs.join(', #')}</span>}</div>
      {(record.before !== null || record.after !== null) && <div className={css.changePair}>{record.before !== null && <div><span>{t('before')}</span><p>{record.before}</p></div>}{record.after !== null && <div><span>{t('after')}</span><p>{record.after}</p></div>}</div>}{record.reason && <p className={css.reason}>{t('reason')}：{record.reason}</p>}
    </article>)}</div>}
  </section>
}

export function SessionMemorySection({ useSessions, useWorkspaces, remote, commands, t }: SessionMemorySectionProps) {
  if (remote === undefined || t === undefined) return null
  const sessions = useSessions(state => state); const workspaces = useWorkspaces(state => state)
  const [selectedId, setSelectedId] = useState<string | undefined>(sessions.current ?? sessions.ids[0])
  const [view, setView] = useState<SessionMemoryView>(); const [draft, setDraft] = useState<EditableDocument>(); const [status, setStatus] = useState('')
  const visibleIds = useMemo(() => visibleSessionIds(sessions.ids, workspaces.items.flatMap(workspace => workspace.sessionIds), workspaces.archivedSessionIds, workspaces.baselinesReady), [sessions.ids, workspaces.items, workspaces.archivedSessionIds, workspaces.baselinesReady])
  const selected = visibleSessionSelection(selectedId, sessions.current, visibleIds)
  const options = useMemo(() => visibleIds.map(id => sessions.byId[id]).filter((option): option is NonNullable<typeof option> => option !== undefined), [sessions.byId, visibleIds])
  useEffect(() => { if (selectedId !== selected) { setView(undefined); setDraft(undefined); setSelectedId(selected) } }, [selected, selectedId])
  const load = async () => {
    if (selected === undefined) return; setStatus(t('loading'))
    try {
      const response = await remote.get(selected as never); if (!response.ok) throw new Error(response.error.message)
      let policy = DEFAULT_COMPACTION_POLICY; let warning = ''
      try { const result = await remote.getCompactionPolicy(selected as never); if (!result.ok) throw new Error(result.error.message); policy = result.value } catch (error) { warning = `记忆已载入；上下文压缩设置暂不可用：${error instanceof Error ? error.message : String(error)}` }
      setView(response.value); setDraft({ expectedRevision: response.value.document.revision, people: [...response.value.document.people], assistantRequirements: [...response.value.document.assistantRequirements], memories: [...response.value.document.memories], compactionPolicy: policy }); setStatus(warning)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }
  useEffect(() => { void load() }, [selected])
  if (!workspaces.baselinesReady) return <div className={css.section}><h2>{t('title')}</h2><p>{t('loading')}</p></div>
  if (options.length === 0) return <div className={css.section}><h2>{t('title')}</h2><p>{t('empty')}</p></div>
  const save = async () => {
    if (selected === undefined || !draft || !view) return; setStatus(t('loading'))
    try {
      let response = await remote.replace(selected as never, { expectedRevision: draft.expectedRevision, people: draft.people, assistantRequirements: draft.assistantRequirements, memories: draft.memories }); if (!response.ok) throw new Error(response.error.message)
      let result = response.value
      if (!result.ok && result.error.code === 'stale-revision') { const latest = await remote.get(selected as never); if (!latest.ok) throw new Error(latest.error.message); response = await remote.replace(selected as never, mergeDraftOverLatest(draft, view.document, latest.value.document)); if (!response.ok) throw new Error(response.error.message); result = response.value }
      if (!result.ok) { setStatus(result.error.message); return }
      setView(result.value); setDraft({ ...draft, expectedRevision: result.value.document.revision, people: [...result.value.document.people], assistantRequirements: [...result.value.document.assistantRequirements], memories: [...result.value.document.memories] }); setStatus(t('saved'))
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }
  const applyPolicy = async () => { if (selected === undefined || !draft) return; try { const result = await remote.setCompactionPolicy(selected as never, draft.compactionPolicy); if (!result.ok) throw new Error(result.error.message); setDraft({ ...draft, compactionPolicy: result.value }); setStatus('上下文压缩设置已实时应用到当前会话。') } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) } }
  const updatePerson = (index: number, patch: Partial<SessionPerson>) => { if (!draft) return; setDraft({ ...draft, people: draft.people.map((value, at) => at === index ? { ...value, ...patch, source: 'user', updatedAt: Date.now() } : value) }) }
  return <div className={css.section} data-session-memory-center><header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
    <label className={css.sessionSelect}><span>{t('session')}</span><select value={selected} onChange={event => setSelectedId(event.target.value)}>{options.map(option => <option value={option.id} key={option.id}>{option.displayTitle}</option>)}</select></label>
    {draft && <>
      <section className={css.card} data-context-compaction><div className={css.cardTitle}><div><h3>上下文压缩</h3><p>仅压缩该会话较早的对话；人物、要求和记忆不会进入摘要。</p></div><label className={css.switch}><input type="checkbox" checked={draft.compactionPolicy.enabled} onChange={event => setDraft({ ...draft, compactionPolicy: { ...draft.compactionPolicy, enabled: event.target.checked } })}/><span>{draft.compactionPolicy.enabled ? '已启用' : '已关闭'}</span></label></div>
        <label><span>达到 {Math.round(draft.compactionPolicy.thresholdRatio * 1000) / 10}% 上下文时自动压缩</span><input type="range" min="5" max="80" step="0.1" value={draft.compactionPolicy.thresholdRatio * 100} onChange={event => setDraft({ ...draft, compactionPolicy: { ...draft.compactionPolicy, thresholdRatio: Number(event.target.value) / 100 } })}/></label>
        <div className={css.twoColumn}><label><span>保留末尾原文（tokens）</span><input type="number" min="4096" step="1024" value={draft.compactionPolicy.retainTokens} onChange={event => setDraft({ ...draft, compactionPolicy: { ...draft.compactionPolicy, retainTokens: Math.max(4096, Number(event.target.value) || 4096) } })}/></label><label><span>摘要上限（tokens）</span><input type="number" min="512" max="8192" step="256" value={draft.compactionPolicy.maxTokens} onChange={event => setDraft({ ...draft, compactionPolicy: { ...draft.compactionPolicy, maxTokens: Math.min(8192, Math.max(512, Number(event.target.value) || 512)) } })}/></label></div>
        <button className={css.subtleAction} type="button" onClick={() => void applyPolicy()}>应用压缩设置</button><button className={css.subtleAction} type="button" disabled={commands === undefined} onClick={async () => { if (!commands || selected === undefined) return; setStatus(await executeManualCompaction(commands, selected as never)) }}>立即压缩当前会话</button>
      </section>
      <section className={css.card}><div className={css.cardTitle}><div><h3>{t('people')}</h3><p>{t('peopleHint')}</p></div><span className={css.limitBadge}>{draft.people.length}/5</span></div>
        <div className={css.structuredGrid}>{draft.people.map((entry, index) => <article className={css.memoryCard} key={entry.id}><div className={css.memoryCardHeader}><span>人物{index + 1}{index === 0 ? ' · 当前发言者' : ''}</span><button type="button" onClick={() => setDraft({ ...draft, people: draft.people.filter(value => value.id !== entry.id) })}>{t('remove')}</button></div>
          <label><span>{t('personName')}</span><input value={entry.name} onChange={event => updatePerson(index, { name: event.target.value })}/></label><label><span>{t('personInformation')}</span><textarea rows={4} value={entry.information} onChange={event => updatePerson(index, { information: Array.from(event.target.value).slice(0, 300).join('') })}/><small>{Array.from(entry.information).length}/300</small></label>
        </article>)}</div><button className={css.addGroupButton} type="button" disabled={draft.people.length >= 5} onClick={() => setDraft({ ...draft, people: [...draft.people, person(draft.people.length)] })}>{t('addPerson')}</button>
      </section>
      <section className={css.card}><div className={css.cardTitle}><div><h3>{t('preferences')}</h3><p>{t('preferencesHint')}</p></div></div>{draft.people.map((entry, index) => <label key={entry.id}><span>人物{index + 1} · {entry.name || '未命名'}</span><textarea rows={3} value={entry.preference} onChange={event => updatePerson(index, { preference: Array.from(event.target.value).slice(0, 300).join('') })}/><small>{Array.from(entry.preference).length}/300</small></label>)}</section>
      <StructuredItemEditor title={t('instructions')} hint={t('instructionsHint')} items={draft.assistantRequirements} onChange={assistantRequirements => setDraft({ ...draft, assistantRequirements })} t={t}/>
      <section className={css.card}><div className={css.cardTitle}><div><h3>{t('relationships')}</h3><p>{t('relationshipsHint')}</p></div></div>{draft.people.map((entry, index) => <label key={entry.id}><span>人物{index + 1} · {entry.name || '未命名'}</span><textarea rows={3} value={entry.relationship} onChange={event => updatePerson(index, { relationship: event.target.value })}/></label>)}</section>
      <StructuredItemEditor title={t('memories')} hint={t('memoriesHint')} items={draft.memories} onChange={memories => setDraft({ ...draft, memories })} t={t}/>
      <Activity records={view?.memoryActivity ?? []} t={t}/><footer className={css.footer}><span>{status}</span><button type="button" onClick={() => void load()}>{t('reload')}</button><button className={css.primary} type="button" onClick={() => void save()}>{t('save')}</button></footer>
    </>}{!draft && <p>{status || t('loading')}</p>}
  </div>
}
