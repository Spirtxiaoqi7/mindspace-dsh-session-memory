/** Selection moved from the Session controller to main-view retention in DSH 0.2. */
export function currentSessionId(state: {
  current?: string
  byId: Record<string, { id: string; retainedBy?: Readonly<Record<string, number>> }>
}): string | undefined {
  return state.current ?? Object.values(state.byId).find(row => (row.retainedBy?.['mainView'] ?? 0) > 0)?.id
}

/** Resolve capabilities when used: navigation may activate after this plugin. */
export function openMemorySession(sessionId: string, workspace: { openSession(id: never): void } | undefined, sessions: { open?: (id: never) => void }): void {
  if (workspace) workspace.openSession(sessionId as never)
  else if (sessions.open) sessions.open(sessionId as never)
  else throw new Error('当前桌面端未提供打开会话的接口，请从侧栏打开新会话。')
}
