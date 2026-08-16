/** Personalization editor for one selected session-memory projection. */
import { useEffect, useMemo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ReplaceSessionMemoryRequest,
  SessionMemoryActivity,
  SessionMemoryItem,
  SessionMemoryMutationResult,
  SessionMemoryView,
} from '../memory/types.ts'
import type { SessionMemoryKey } from './locales.ts'
import css from './SessionMemorySection.module.css'

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

interface SessionMemoryRemote {
  get(agentId: never): Promise<RemoteResult<SessionMemoryView>>
  replace(agentId: never, request: ReplaceSessionMemoryRequest): Promise<RemoteResult<SessionMemoryMutationResult>>
}

export interface SessionMemorySectionInjected {
  remote: SessionMemoryRemote
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
export function SessionMemorySection({ useSessions, remote, t }: SessionMemorySectionProps) {
  if (remote === undefined || t === undefined) return null
  const sessions = useSessions(state => state)
  const [selected, setSelected] = useState<string | undefined>(sessions.current ?? sessions.ids[0])
  const [view, setView] = useState<SessionMemoryView | undefined>()
  const [draft, setDraft] = useState<EditableDocument | undefined>()
  const [status, setStatus] = useState('')
  const row = selected === undefined ? undefined : sessions.byId[selected as keyof typeof sessions.byId]
  const options = useMemo(
    () => sessions.ids.map(id => sessions.byId[id]).filter((option): option is NonNullable<typeof option> => option !== undefined),
    [sessions],
  )

  const load = async () => {
    if (selected === undefined) return
    setStatus(t('loading'))
    try {
      const response = await remote.get(selected as never)
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      const next = response.value
      setView(next)
      setDraft({
        expectedRevision: next.document.revision,
        userProfile: next.document.userProfile,
        preferences: [...next.document.preferences].slice(0, 3),
        assistantInstructions: [...next.document.assistantInstructions].slice(0, 3),
        relationship: next.document.relationship,
        roleplayPreset: next.document.roleplayPreset,
      })
      setStatus('')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }

  useEffect(() => { void load() }, [selected])
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
      if (!result.ok) { setStatus(result.error.code === 'stale-revision' ? t('stale') : result.error.message); return }
      setView(result.value)
      setDraft({ ...draft, expectedRevision: result.value.document.revision, userProfile: result.value.document.userProfile })
      setStatus(t('saved'))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const profileLength = draft === undefined ? 0 : Array.from(`${draft.userProfile.confirmed}${draft.userProfile.inferred}`).length
  return <div className={css.section} data-session-memory-center>
    <header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
    <label className={css.sessionSelect}><span>{t('session')}</span>
      <select value={selected} onChange={(event) => { setSelected(event.target.value) }}>
        {options.map(option => <option value={option.id} key={option.id}>{option.displayTitle}</option>)}
      </select>
    </label>
    {draft !== undefined && <>
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
