/** Small host projection: keep only evidence pointers and legacy memory events. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

const key = 'mindspace-memory-evidence'
export type MemoryEvidence = { seq: number; role: string; text: string }
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'mindspace-memory-evidence': { events: SessionEvent[]; transcript: MemoryEvidence[] } }
}
export const memoryTranscript = (ctx: Context, session: Session): MemoryEvidence[] => ctx.sessionProjections.stateOf(session, key)?.transcript ?? []
export function installMemoryEventState(ctx: Context): (session: Session) => readonly SessionEvent[] {
  ctx.sessionProjections.register({
    key, stateVersion: 2,
    stateSchema: z.object({ events: z.array(z.custom<SessionEvent>()), transcript: z.array(z.object({ seq: z.number(), role: z.string(), text: z.string() })) }),
    init: () => ({ events: [], transcript: [] }),
    apply: (state, event) => {
      let transcript = state.transcript
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        const content = event.type === 'assistant/message' ? event.data.message.content : event.data.content
        const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (text && (event.type === 'assistant/message' || event.data.source.kind === 'user')) transcript = [...transcript, { seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text }]
      }
      if (event.type === 'compaction/end' && !event.data.error) transcript = []
      if (event.type.startsWith('memory/') || event.type.startsWith('session-memory/')) return { transcript, events: [...state.events, event] }
      if (!['user/message', 'turn/end', 'compaction/start', 'compaction/end'].includes(event.type)) return transcript === state.transcript ? state : { ...state, transcript }
      return { transcript, events: [...state.events.filter(row => row.type !== event.type), event] }
    },
  })
  return session => ctx.sessionProjections.stateOf(session, key)?.events ?? []
}
