/** Personalization editor for one selected session-memory projection. */
import { useEffect, useMemo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ReplaceSessionMemoryRequest,
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

function item(text = ''): SessionMemoryItem {
  return { id: `draft-${crypto.randomUUID()}`, text, source: 'user', evidenceSeqs: [] }
}

interface ItemEditorProps {
  title: string
  items: readonly SessionMemoryItem[]
  onChange: (items: SessionMemoryItem[]) => void
  t: SessionMemorySectionInjected['t']
}

function ItemEditor({ title, items, onChange, t }: ItemEditorProps) {
  return <section className={css.card}>
    <h3>{title}</h3>
    {items.map((entry, index) => <div className={css.itemRow} key={entry.id}>
      <input value={entry.text} onChange={(event) => {
        onChange(items.map((value, at) => at === index
          ? { ...value, text: event.target.value, source: 'user' }
          : value))
      }} />
      <button type="button" onClick={() => { onChange(items.filter(value => value.id !== entry.id)) }}>
        {t('remove')}
      </button>
    </div>)}
    <button className={css.add} type="button" onClick={() => { onChange([...items, item()]) }}>{t('add')}</button>
  </section>
}

/** Render and mutate one selected session's memory document. */
export function SessionMemorySection({ useSessions, remote, t }: SessionMemorySectionProps) {
  if (remote === undefined || t === undefined) return null
  const sessions = useSessions(state => state)
  const [selected, setSelected] = useState<string | undefined>(sessions.current ?? sessions.ids[0])
  const [view, setView] = useState<SessionMemoryView | undefined>()
  const [draft, setDraft] = useState<ReplaceSessionMemoryRequest | undefined>()
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
        summaryOverride: next.document.summaryOverride,
        preferences: [...next.document.preferences],
        userFacts: [...next.document.userFacts],
        assistantInstructions: [...next.document.assistantInstructions],
        relationship: next.document.relationship,
        roleplayPreset: next.document.roleplayPreset,
      })
      setStatus('')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }

  useEffect(() => { void load() }, [selected])
  if (options.length === 0) return <div className={css.section}><h2>{t('title')}</h2><p>{t('empty')}</p></div>

  const save = async () => {
    if (selected === undefined || draft === undefined) return
    setStatus(t('loading'))
    try {
      const response = await remote.replace(selected as never, draft)
      if (!response.ok) { setStatus(response.error.message); return }
      const result = response.value
      if (!result.ok) { setStatus(result.error.code === 'stale-revision' ? t('stale') : result.error.message); return }
      setView(result.value)
      setDraft({ ...draft, expectedRevision: result.value.document.revision })
      setStatus(t('saved'))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return <div className={css.section} data-session-memory-center>
    <header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
    <label className={css.sessionSelect}><span>{t('session')}</span>
      <select value={selected} onChange={(event) => { setSelected(event.target.value) }}>
        {options.map(option => <option value={option.id} key={option.id}>{option.displayTitle}</option>)}
      </select>
    </label>
    {draft !== undefined && <>
      <section className={css.card}><h3>{t('summary')}</h3><p>{t('summaryHint')}</p>
        <div className={css.summaryPreview}><span>{t('currentSummary')}</span>
          <pre>{view?.compactionSummary?.text ?? t('noSummary')}</pre>
        </div>
        <label><span>{t('summaryOverride')}</span>
          <textarea
            rows={5}
            value={draft.summaryOverride ?? ''}
            placeholder={t('summaryOverridePlaceholder')}
            onChange={(event) => {
              setDraft({
                ...draft,
                summaryOverride: event.target.value.trim().length === 0 ? null : event.target.value,
              })
            }}
          />
        </label>
      </section>
      <ItemEditor
        title={t('preferences')}
        items={draft.preferences}
        onChange={(preferences) => { setDraft({ ...draft, preferences }) }}
        t={t}
      />
      <ItemEditor
        title={t('facts')}
        items={draft.userFacts}
        onChange={(userFacts) => { setDraft({ ...draft, userFacts }) }}
        t={t}
      />
      <ItemEditor
        title={t('instructions')}
        items={draft.assistantInstructions}
        onChange={(assistantInstructions) => { setDraft({ ...draft, assistantInstructions }) }}
        t={t}
      />
      <section className={css.card}><h3>{t('relationship')}</h3>
        <label><span>{t('role')}</span><input value={draft.relationship?.role ?? ''} onChange={(event) => {
          setDraft({
            ...draft,
            relationship: {
              role: event.target.value,
              mission: draft.relationship?.mission ?? '',
              guidance: draft.relationship?.guidance ?? '',
            },
          })
        }} /></label>
        <label><span>{t('mission')}</span><input value={draft.relationship?.mission ?? ''} onChange={(event) => {
          setDraft({
            ...draft,
            relationship: {
              role: draft.relationship?.role ?? '',
              mission: event.target.value,
              guidance: draft.relationship?.guidance ?? '',
            },
          })
        }} /></label>
        <label><span>{t('guidance')}</span><textarea rows={3} value={draft.relationship?.guidance ?? ''} onChange={(event) => {
          setDraft({
            ...draft,
            relationship: {
              role: draft.relationship?.role ?? '',
              mission: draft.relationship?.mission ?? '',
              guidance: event.target.value,
            },
          })
        }} /></label>
        <button type="button" onClick={() => { setDraft({ ...draft, relationship: null }) }}>{t('remove')}</button>
      </section>
      <section className={css.card}><div className={css.cardTitle}><div>
        <h3>{t('roleplayPreset')}</h3><p>{t('roleplayHint')}</p>
      </div>
      <label className={css.switch}><input
        type="checkbox"
        checked={draft.roleplayPreset?.enabled ?? false}
        onChange={(event) => {
          setDraft({
            ...draft,
            roleplayPreset: { enabled: event.target.checked, text: draft.roleplayPreset?.text ?? '' },
          })
        }}
      /><span>{draft.roleplayPreset?.enabled ? t('enabled') : t('disabled')}</span></label>
      </div>
      <textarea
        rows={6}
        value={draft.roleplayPreset?.text ?? ''}
        placeholder={t('roleplayPlaceholder')}
        onChange={(event) => {
          setDraft({
            ...draft,
            roleplayPreset: { enabled: draft.roleplayPreset?.enabled ?? false, text: event.target.value },
          })
        }}
      />
      <button type="button" onClick={() => { setDraft({ ...draft, roleplayPreset: null }) }}>
        {t('clearPreset')}
      </button>
      </section>
      <footer className={css.footer}><span>{status}</span><button type="button" onClick={() => void load()}>{t('reload')}</button><button className={css.primary} type="button" onClick={() => void save()}>{t('save')}</button></footer>
    </>}
    {draft === undefined && <p>{status || `${t('loading')} ${row?.displayTitle ?? ''}`}</p>}
  </div>
}
