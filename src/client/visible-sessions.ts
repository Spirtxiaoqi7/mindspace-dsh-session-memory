/**
 * Settings pages receive the complete session history, whereas the workspace
 * browser layers the archive set over it.  Keep that same rule here: archive
 * means unavailable for personalization editing, not a destructive memory
 * purge that would make a later restore impossible.
 */
export function visibleSessionIds(
  sessionIds: readonly string[],
  workspaceSessionIds: readonly string[],
  archivedSessionIds: readonly string[],
  baselinesReady: boolean,
): readonly string[] {
  // The workspace store starts with an empty archive set.  Treating that
  // placeholder as truth briefly exposes every archived session on a cold
  // settings-page mount.  Only project sessions after both Host baselines
  // have completed; an error/pending baseline fails closed instead.
  if (!baselinesReady) return []
  const inWorkspace = new Set(workspaceSessionIds)
  const archived = new Set(archivedSessionIds)
  return sessionIds.filter(sessionId => inWorkspace.has(sessionId) && !archived.has(sessionId))
}

/** Choose a valid, non-archived selection without retaining an archived id. */
export function visibleSessionSelection(
  selected: string | undefined,
  current: string | undefined,
  visibleIds: readonly string[],
): string | undefined {
  if (selected !== undefined && visibleIds.includes(selected)) return selected
  if (current !== undefined && visibleIds.includes(current)) return current
  return visibleIds[0]
}
