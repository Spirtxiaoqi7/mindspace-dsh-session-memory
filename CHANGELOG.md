# Changelog

## 0.2.10 - 2026-08-16

- Fixed the Memory Center save failure caused by putting context-compaction
  fields inside the versioned `sessionMemory/replace` wire request.
- Moved context-compaction reads and writes to dedicated Remote methods, so
  policy changes persist and take effect for the current session without
  rewriting personalization memory.

## 0.2.9 - 2026-08-16

- Added a per-session context-compaction policy: enable state, trigger ratio,
  retained recent context, and summary limit are stored as durable session events.
- Added an editable settings card with a trigger slider and an explicit
  “compact now” action for the active conversation.
- Automatic compaction reads the session policy without incorporating system,
  tool, relationship, roleplay, or personalization prompt layers into the
  summary.
- Tightened the summarizer instruction to preserve durable conversation facts
  while dropping greetings, repeated material, and tool-log noise.

## 0.2.7

- Make clean DSH Web profile installation self-contained by disabling the
  conflicting in-tree experimental session-memory service and its UI row
  before mounting DSH-memory's own Remote and settings surface.

## 0.2.6

- Show the exact session-identity fragment that is injected ahead of the
  default Harness identity after a relationship mission is saved.
- Clarify in the editor that the roleplay preset is a separate enabled-only
  style layer and cannot override the session mission.

## 0.2.5

- Promote an explicit per-session relationship mission into the first identity
  prompt slot, replacing the generic Harness opener without dropping Web or
  tool instructions.
- Keep the roleplay preset as a separate, enabled-only style layer instead of
  conflating it with the session identity.

## 0.2.4

- Fix the Personalization settings panel on current DSH runtimes by resolving
  the plugin-owned Remote after it is mounted, instead of reading it from a
  guarded dependency context during slot rendering.

## 0.2.3

- Mark plugin-owned session events as ignorable persistence records so an
  external plugin cannot make a session unreadable after a cold restart.
- Add a backed-up, atomic repair utility for logs written by 0.2.2 and older.

## 0.2.1 - 2026-08-14

- Removed compatibility overrides for two experimental in-tree entry ids.
- Made the bundle patch cleanly installable on an unmodified official Web profile without `entry not found` diagnostics.

## 0.2.0 - 2026-08-14

- Replaced the public DSH compaction override with a compact confirmed/inferred user profile.
- Consolidated preferences and assistant rules into at most three categorized cards per section.
- Added category-based merge and explicit conflict replacement without model-supplied item ids.
- Added atomic complete-state extraction with a handled/skipped atom ledger.
- Added visible append/merge/replace/skip activity including evidence, before/after values, and reasons.
- Added V1 event migration while keeping legacy history replayable.
- Repaired duplicate fallback categories during replay so legacy documents cannot block later writes.
- Added a dedicated assistant-identity action for names, nicknames, and relationship-specific titles.

## 0.1.0 - 2026-08-14

- Initial community-plugin release.
- Editable per-session memory center and direct DSH compaction preview.
- Preferences, user facts, assistant instructions, relationship mission, and roleplay preset.
- Model read/write tools, conservative extraction, conflict replacement, and audit history.
- One-time optional personalization question for empty new sessions.
- Prebuilt DSH bundle with self-mounted Web Remote and no upstream source patch.
