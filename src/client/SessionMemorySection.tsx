/** Personalization editor for one selected session-memory projection. */
import { useEffect, useMemo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ReplaceSessionMemoryRequest,
  SessionMemoryActivity,
  SessionMemoryItem,
  SessionMemoryMutationResult,
  SessionMemoryView,
  ContextCompactionPolicy,
} from '../memory/types.ts'
import type { SessionMemoryKey } from './locales.ts'
import { visibleSessionIds, visibleSessionSelection } from './visible-sessions.ts'
import css from './SessionMemorySection.module.css'

const DEFAULT_COMPACTION_POLICY: ContextCompactionPolicy = {
  enabled: true, thresholdRatio: 0.164, retainTokens: 64_000, maxTokens: 6_000, updatedAt: 0,
}

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

interface SessionMemoryRemote {
  get(agentId: never): Promise<RemoteResult<SessionMemoryView>>
  replace(agentId: never, request: ReplaceSessionMemoryRequest): Promise<RemoteResult<SessionMemoryMutationResult>>
  getCompactionPolicy(agentId: never): Promise<RemoteResult<ContextCompactionPolicy>>
  setCompactionPolicy(agentId: never, policy: ContextCompactionPolicy): Promise<RemoteResult<ContextCompactionPolicy>>
}

export interface CommandsRemote {
  execute(agentId: never, line: string, images: readonly never[]): Promise<RemoteResult<{
    readonly result: { readonly kind: 'success' | 'error'; readonly text?: string }
  } | undefined>>
}

/** Execute the current DSH command contract and report the settled outcome. */
export async function executeManualCompaction(commands: CommandsRemote, agentId: never): Promise<string> {
  const response = await commands.execute(agentId, '/compact', [])
  if (!response.ok) return response.error.message
  if (response.value === undefined) return '当前会话没有可用的 /compact 命令。'
  const result = response.value.result
  return result.kind === 'success'
    ? (result.text ?? '主动压缩已完成。')
    : (result.text ?? '主动压缩未执行。')
}

export interface SessionMemorySectionInjected {
  remote: SessionMemoryRemote
  commands?: CommandsRemote
  t: (key: SessionMemoryKey) => string
}

export type SessionMemorySectionProps = PropsRuntime<'settings.section'> & Partial<SessionMemorySectionInjected>

interface EditableDocument {
  expectedRevision: number
  userProfile: SessionMemoryView['document']['userProfile']
  preferences: SessionMemoryItem[]
  assistantInstructions: SessionMemoryItem[]
  relationship: SessionMemoryView['document']['relationship']
  roleplayPreset: SessionMemoryView['document']['roleplayPreset']
  compactionPolicy: ContextCompactionPolicy
}

function sameMemoryValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Apply only sections changed in this editor over the newest persisted document. */
function mergeDraftOverLatest(
  draft: EditableDocument,
  baseline: SessionMemoryView['document'],
  latest: SessionMemoryView['document'],
): ReplaceSessionMemoryRequest {
  return {
    expectedRevision: latest.revision,
    userProfile: sameMemoryValue(draft.userProfile, baseline.userProfile) ? latest.userProfile : draft.userProfile,
    preferences: sameMemoryValue(draft.preferences, baseline.preferences) ? latest.preferences : draft.preferences,
    assistantInstructions: sameMemoryValue(draft.assistantInstructions, baseline.assistantInstructions)
      ? latest.assistantInstructions
      : draft.assistantInstructions,
    relationship: sameMemoryValue(draft.relationship, baseline.relationship) ? latest.relationship : draft.relationship,
    roleplayPreset: sameMemoryValue(draft.roleplayPreset, baseline.roleplayPreset) ? latest.roleplayPreset : draft.roleplayPreset,
  }
}

function item(text = ''): SessionMemoryItem {
  return { id: `draft-${crypto.randomUUID()}`, category: '', text, source: 'user', evidenceSeqs: [] }
}

interface ItemEditorProps {
  title: string
  hint: string
  items: readonly SessionMemoryItem[]
  onChange: (items: SessionMemoryItem[]) => void
  t: SessionMemorySectionInjected['t']
}

function StructuredItemEditor({ title, hint, items, onChange, t }: ItemEditorProps) {
  const visible = items.slice(0, 3)
  return <section className={css.card}>
    <div className={css.cardTitle}>
      <div><h3>{title}</h3><p>{hint}</p></div>
      <span className={css.limitBadge}>{visible.length}/3</span>
    </div>
    <div className={css.structuredGrid}>
      {visible.map((entry, index) => <article className={css.memoryCard} key={entry.id}>
        <div className={css.memoryCardHeader}>
          <span>{t('group')} {index + 1}</span>
          <button type="button" onClick={() => { onChange(items.filter(value => value.id !== entry.id)) }}>
            {t('remove')}
          </button>
        </div>
        <input
          className={css.categoryInput}
          value={entry.category}
          placeholder={t('categoryPlaceholder')}
          onChange={(event) => {
            onChange(items.map((value, at) => at === index
              ? { ...value, category: event.target.value, source: 'user' }
              : value))
          }}
        />
        <textarea
          rows={3}
          value={entry.text}
          placeholder={t('structuredPlaceholder')}
          onChange={(event) => {
            onChange(items.map((value, at) => at === index
              ? { ...value, text: event.target.value, source: 'user' }
              : value))
          }}
        />
      </article>)}
    </div>
    <button
      className={css.addGroupButton}
      type="button"
      disabled={visible.length >= 3}
      title={visible.length >= 3 ? t('mergeFirst') : undefined}
      onClick={() => { onChange([...visible, item()]) }}
    >{visible.length >= 3 ? t('groupLimit') : t('addGroup')}</button>
  </section>
}

function Activity({ records, t }: { records: readonly SessionMemoryActivity[]; t: SessionMemorySectionInjected['t'] }) {
  const labels = { append: t('activityAppend'), merge: t('activityMerge'), replace: t('activityReplace'), skip: t('activitySkip') }
  const sections: Record<SessionMemoryActivity['section'], string> = {
    userProfile: t('profile'), preferences: t('preferences'), assistantInstructions: t('instructions'),
    relationship: t('relationship'), roleplayPreset: t('roleplayPreset'),
  }
  return <section className={css.card}>
    <div className={css.cardTitle}><div><h3>{t('activity')}</h3><p>{t('activityHint')}</p></div></div>
    {records.length === 0
      ? <div className={css.emptyState}>{t('noActivity')}</div>
      : <div className={css.activityList}>{records.slice(-12).reverse().map(record => <article className={css.activityRow} key={record.id}>
        <div className={css.activityMeta}>
          <span className={`${css.operation} ${css[record.operation]}`}>{labels[record.operation]}</span>
          <strong>{sections[record.section]}</strong>
          {record.sourceSeqs.length > 0 && <span>#{record.sourceSeqs.join(', #')}</span>}
        </div>
        {(record.before !== null || record.after !== null) && <div className={css.changePair}>
          {record.before !== null && <div><span>{t('before')}</span><p>{record.before}</p></div>}
          {record.after !== null && <div><span>{t('after')}</span><p>{record.after}</p></div>}
        </div>}
        {record.reason.length > 0 && <p className={css.reason}>{t('reason')}：{record.reason}</p>}
      </article>)}</div>}
  </section>
}

/** Render and mutate one selected session's memory document. */
export function SessionMemorySection({ useSessions, useWorkspaces, remote, commands, t }: SessionMemorySectionProps) {
  if (remote === undefined || t === undefined) return null
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const [selectedId, setSelectedId] = useState<string | undefined>(sessions.current ?? sessions.ids[0])
  const [view, setView] = useState<SessionMemoryView | undefined>()
  const [draft, setDraft] = useState<EditableDocument | undefined>()
  const [status, setStatus] = useState('')
  const visibleIds = useMemo(
    () => visibleSessionIds(
      sessions.ids,
      workspaces.items.flatMap(workspace => workspace.sessionIds),
      workspaces.archivedSessionIds,
      workspaces.baselinesReady,
    ),
    [sessions.ids, workspaces.items, workspaces.archivedSessionIds, workspaces.baselinesReady],
  )
  const selected = visibleSessionSelection(selectedId, sessions.current, visibleIds)
  const row = selected === undefined ? undefined : sessions.byId[selected as keyof typeof sessions.byId]
  const options = useMemo(
    () => visibleIds.map(id => sessions.byId[id]).filter((option): option is NonNullable<typeof option> => option !== undefined),
    [sessions.byId, visibleIds],
  )

  // A workspace archive may arrive while this page is open.  Clear the stale
  // selection before any memory Remote request can read or mutate it.
  useEffect(() => {
    if (selectedId !== selected) {
      setView(undefined)
      setDraft(undefined)
      setSelectedId(selected)
    }
  }, [selected, selectedId])

  const load = async () => {
    if (selected === undefined) return
    setStatus(t('loading'))
    try {
      // Personalization data and the optional compression controls are deliberately
      // loaded independently: an old/invalid policy must never hide user memory.
      const response = await remote.get(selected as never)
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      const next = response.value
      let compactionPolicy = DEFAULT_COMPACTION_POLICY
      let policyWarning = ''
      try {
        const policyResponse = await remote.getCompactionPolicy(selected as never)
        if (!policyResponse.ok) throw new Error(`${policyResponse.error.code}: ${policyResponse.error.message}`)
        compactionPolicy = policyResponse.value
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        policyWarning = `记忆已载入；上下文压缩设置暂不可用：${detail}`
      }
      setView(next)
      setDraft({
        expectedRevision: next.document.revision,
        userProfile: next.document.userProfile,
        preferences: [...next.document.preferences].slice(0, 3),
        assistantInstructions: [...next.document.assistantInstructions].slice(0, 3),
        relationship: next.document.relationship,
        roleplayPreset: next.document.roleplayPreset,
        compactionPolicy,
      })
      setStatus(policyWarning)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }

  useEffect(() => { void load() }, [selected])
  if (!workspaces.baselinesReady) {
    return <div className={css.section}><h2>{t('title')}</h2><p>{t('loading')}</p></div>
  }
  if (options.length === 0) return <div className={css.section}><h2>{t('title')}</h2><p>{t('empty')}</p></div>

  const save = async () => {
    if (selected === undefined || draft === undefined || view === undefined) return
    setStatus(t('loading'))
    const request: ReplaceSessionMemoryRequest = {
      expectedRevision: draft.expectedRevision,
      userProfile: draft.userProfile,
      preferences: draft.preferences,
      assistantInstructions: draft.assistantInstructions,
      relationship: draft.relationship,
      roleplayPreset: draft.roleplayPreset,
    }
    try {
      const response = await remote.replace(selected as never, request)
      if (!response.ok) { setStatus(response.error.message); return }
      const result = response.value
      if (!result.ok) {
        if (result.error.code === 'stale-revision') {
          // The extractor may have changed another section while the user was
          // editing. Rebase just the user's changed sections once, preserving
          // every untouched newest section. A second conflict keeps the draft.
          const latestResponse = await remote.get(selected as never)
          if (!latestResponse.ok) { setStatus(latestResponse.error.message); return }
          const rebased = mergeDraftOverLatest(draft, view.document, latestResponse.value.document)
          const retryResponse = await remote.replace(selected as never, rebased)
          if (!retryResponse.ok) { setStatus(retryResponse.error.message); return }
          const retry = retryResponse.value
          if (!retry.ok) {
            setStatus(retry.error.code === 'stale-revision'
              ? '记忆仍在持续变化，已保留你的未保存草稿；请稍后保存或重新载入。'
              : retry.error.message)
            return
          }
          setView(retry.value)
          setDraft({ ...draft, expectedRevision: retry.value.document.revision, userProfile: retry.value.document.userProfile,
            preferences: [...retry.value.document.preferences], assistantInstructions: [...retry.value.document.assistantInstructions],
            relationship: retry.value.document.relationship, roleplayPreset: retry.value.document.roleplayPreset })
          setStatus('已将你的修改合并到最新记忆；未改动的内容已保留。')
        } else setStatus(result.error.message)
        return
      }
      setView(result.value)
      setDraft({ ...draft, expectedRevision: result.value.document.revision, userProfile: result.value.document.userProfile })
      setStatus(t('saved'))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const applyCompactionPolicy = async () => {
    if (selected === undefined || draft === undefined) return
    setStatus('正在应用上下文压缩设置…')
    try {
      const response = await remote.setCompactionPolicy(selected as never, draft.compactionPolicy)
      if (!response.ok) { setStatus(response.error.message); return }
      setDraft({ ...draft, compactionPolicy: response.value })
      setStatus('上下文压缩设置已实时应用到当前会话。')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }

  const profileLength = draft === undefined ? 0 : Array.from(`${draft.userProfile.confirmed}${draft.userProfile.inferred}`).length
  return <div className={css.section} data-session-memory-center>
    <header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
    <label className={css.sessionSelect}><span>{t('session')}</span>
      <select value={selected} onChange={(event) => { setSelectedId(event.target.value) }}>
        {options.map(option => <option value={option.id} key={option.id}>{option.displayTitle}</option>)}
      </select>
    </label>
    {draft !== undefined && <>
      <section className={css.card} data-context-compaction>
        <div className={css.cardTitle}><div><h3>上下文压缩</h3><p>仅压缩该会话较早的对话记忆；用户画像、关系使命、扮演预设和系统提示不会进入摘要。</p></div>
          <label className={css.switch}><input type="checkbox" checked={draft.compactionPolicy.enabled} onChange={(event) => setDraft({ ...draft, compactionPolicy: { ...draft.compactionPolicy, enabled: event.target.checked } })} /><span>{draft.compactionPolicy.enabled ? '已启用' : '已关闭'}</span></label>
        </div>
        <label><span>达到 {Math.round(draft.compactionPolicy.thresholdRatio * 1000) / 10}% 上下文时自动压缩</span><input type="range" min="5" max="80" step="0.1" value={draft.compactionPolicy.thresholdRatio * 100} onChange={(event) => setDraft({ ...draft, compactionPolicy: { ...draft.compactionPolicy, thresholdRatio: Number(event.target.value) / 100 } })} /></label>
        <div className={css.twoColumn}>
          <label><span>保留末尾原文（tokens）</span><input type="number" min="4096" step="1024" value={draft.compactionPolicy.retainTokens} onChange={(event) => setDraft({ ...draft, compactionPolicy: { ...draft.compactionPolicy, retainTokens: Math.max(4096, Number(event.target.value) || 4096) } })} /></label>
          <label><span>摘要上限（tokens）</span><input type="number" min="512" max="8192" step="256" value={draft.compactionPolicy.maxTokens} onChange={(event) => setDraft({ ...draft, compactionPolicy: { ...draft.compactionPolicy, maxTokens: Math.min(8192, Math.max(512, Number(event.target.value) || 512)) } })} /></label>
        </div>
        <p>按当前模型上报的上下文窗口计算；保留末尾原文应小于触发预算。应用后下一轮请求即时按此会话策略执行。</p>
        <button className={css.subtleAction} type="button" onClick={() => void applyCompactionPolicy()}>应用压缩设置</button>
        <button className={css.subtleAction} type="button" disabled={selected === undefined || commands === undefined} onClick={async () => {
          if (selected === undefined || commands === undefined) return
          setStatus('正在压缩较早的对话记忆…')
          try {
            setStatus(await executeManualCompaction(commands, selected as never))
          } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
        }}>立即压缩当前会话</button>
      </section>
      <section className={`${css.card} ${css.profileCard}`}>
        <div className={css.cardTitle}>
          <div><h3>{t('profile')}</h3><p>{t('profileHint')}</p></div>
          <span className={profileLength > 300 ? css.counterOver : css.counter}>{profileLength}/300</span>
        </div>
        <label><span>{t('confirmedProfile')}</span><textarea
          rows={5}
          value={draft.userProfile.confirmed}
          placeholder={t('profilePlaceholder')}
          onChange={(event) => {
            const allowed = 300 - Array.from(draft.userProfile.inferred).length
            setDraft({ ...draft, userProfile: { ...draft.userProfile, confirmed: Array.from(event.target.value).slice(0, allowed).join('') } })
          }}
        /></label>
        <label><span>{t('inferredProfile')}</span><textarea
          rows={3}
          value={draft.userProfile.inferred}
          placeholder={t('inferredPlaceholder')}
          onChange={(event) => {
            const allowed = 300 - Array.from(draft.userProfile.confirmed).length
            setDraft({ ...draft, userProfile: { ...draft.userProfile, inferred: Array.from(event.target.value).slice(0, allowed).join('') } })
          }}
        /></label>
      </section>
      <StructuredItemEditor
        title={t('preferences')}
        hint={t('preferencesHint')}
        items={draft.preferences}
        onChange={(preferences) => { setDraft({ ...draft, preferences }) }}
        t={t}
      />
      <StructuredItemEditor
        title={t('instructions')}
        hint={t('instructionsHint')}
        items={draft.assistantInstructions}
        onChange={(assistantInstructions) => { setDraft({ ...draft, assistantInstructions }) }}
        t={t}
      />
      <section className={css.card}><div className={css.cardTitle}><div><h3>{t('relationship')}</h3><p>{t('relationshipHint')}</p></div></div>
        <div className={css.twoColumn}>
          <label><span>{t('role')}</span><input value={draft.relationship?.role ?? ''} onChange={(event) => {
            setDraft({ ...draft, relationship: { role: event.target.value, mission: draft.relationship?.mission ?? '', guidance: draft.relationship?.guidance ?? '' } })
          }} /></label>
          <label><span>{t('mission')}</span><input value={draft.relationship?.mission ?? ''} onChange={(event) => {
            setDraft({ ...draft, relationship: { role: draft.relationship?.role ?? '', mission: event.target.value, guidance: draft.relationship?.guidance ?? '' } })
          }} /></label>
        </div>
        <label><span>{t('guidance')}</span><textarea rows={3} value={draft.relationship?.guidance ?? ''} onChange={(event) => {
          setDraft({ ...draft, relationship: { role: draft.relationship?.role ?? '', mission: draft.relationship?.mission ?? '', guidance: event.target.value } })
        }} /></label>
        {draft.relationship !== null && draft.relationship.role.trim().length > 0 && draft.relationship.mission.trim().length > 0 && <div className={css.promptPreview}>
          <span>{t('identityPreview')}</span>
          <pre>{`You are ${draft.relationship.role.trim()} in this conversation.\nYour primary mission is: ${draft.relationship.mission.trim()}.${draft.relationship.guidance.trim().length === 0 ? '' : `\nSession guidance: ${draft.relationship.guidance.trim()}.`}\nThis user-assigned session mission is authoritative for your role and response stance in this conversation.`}</pre>
        </div>}
        <button className={css.subtleAction} type="button" onClick={() => { setDraft({ ...draft, relationship: null }) }}>{t('clearRelationship')}</button>
      </section>
      <section className={css.card}><div className={css.cardTitle}><div>
        <h3>{t('roleplayPreset')}</h3><p>{t('roleplayHint')}</p>
      </div>
      <label className={css.switch}><input
        type="checkbox"
        checked={draft.roleplayPreset?.enabled ?? false}
        onChange={(event) => { setDraft({ ...draft, roleplayPreset: { enabled: event.target.checked, text: draft.roleplayPreset?.text ?? '' } }) }}
      /><span>{draft.roleplayPreset?.enabled ? t('enabled') : t('disabled')}</span></label>
      </div>
      <textarea
        rows={6}
        value={draft.roleplayPreset?.text ?? ''}
        placeholder={t('roleplayPlaceholder')}
        onChange={(event) => { setDraft({ ...draft, roleplayPreset: { enabled: draft.roleplayPreset?.enabled ?? false, text: event.target.value } }) }}
      />
      <button className={css.subtleAction} type="button" onClick={() => { setDraft({ ...draft, roleplayPreset: null }) }}>{t('clearPreset')}</button>
      </section>
      <Activity records={view?.memoryActivity ?? []} t={t} />
      <footer className={css.footer}><span>{status}</span><button type="button" onClick={() => void load()}>{t('reload')}</button><button className={css.primary} type="button" onClick={() => void save()}>{t('save')}</button></footer>
    </>}
    {draft === undefined && <p>{status || `${t('loading')} ${row?.displayTitle ?? ''}`}</p>}
  </div>
}
