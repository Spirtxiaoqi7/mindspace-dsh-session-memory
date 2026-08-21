# Changelog

## 0.2.35 - 2026-08-22

- Qualified the plugin against DeepSeek Harness `0.1.1-rc.2` and the stable
  `0.1.1` line by raising the peer-dependency floor and removing the RC8 suffix.
- Updated manual compaction for the current three-argument Commands Remote and
  report the settled command result instead of a transport-level false success.
- Made automatic retention model-capacity safe: an impossible absolute tail is
  capped below half of the configured trigger budget, with a ratio fallback
  when catalog capacity is temporarily unavailable.
- Verified the installed Web profile with a real `/compact`: 911 history items
  and approximately 314421 tokens were compacted successfully.

## 0.2.34-rc8 - 2026-08-21

- Fixed context compaction after RC8 moved `compaction-basic` and `/compact`
  into standing Agent presets. The plugin now adapts the provider resolved from
  each live `agent.ctx`, so saved per-session thresholds and summary limits
  control the engine that actually owns the conversation.
- Removed the incorrect host-plane compaction reactivation. Automatic and
  manual compaction now share one serialized, session-scoped policy bridge
  without creating a second engine.

## 0.2.33-rc8 - 2026-08-21

- Aligned Memory Center's selector with the Workspace sidebar: only top-level
  sessions owned by a workspace are eligible, then the global archive set is
  subtracted. Subagent and legacy orphan sessions no longer appear as if they
  were restorable user conversations.

## 0.2.32-rc8 - 2026-08-21

- Fixed a cold-start archive race in Memory Center. The session selector now
  waits for both workspace and session baselines before rendering, so the
  initial empty archive placeholder can never expose archived conversations.
  Archived personalization remains retained for an explicit restore.

## 0.2.31-rc8 - 2026-08-21

- Bumped the sidecar format marker so installations that briefly received the
  first sidecar build re-run the safe, read-only legacy import once. No
  conversation log is rewritten by this migration; repaired originals remain
  alongside timestamped backups.

## 0.2.30-rc8 - 2026-08-21

- Extended sidecar migration to the original Memory Center records
  (`memory/set`, `memory/remove`, `memory/relationship`, and summary-edit
  envelopes) as well as the later governed-memory vocabulary. Existing
  preference cards and relationship missions are retained during the move,
  rather than merely making their conversations replayable.

## 0.2.29-rc8 - 2026-08-21

- Moved all editable personalization state and per-session context-compaction
  policy out of DSH's canonical JSONL event log into an atomic, session-keyed
  sidecar under `DSH_HOME/mindspace-session-memory/v1`. Legacy event-sourced
  state is imported once on first access; future edits never append an
  out-of-tree event that a stock RC8 replay could reject.
- Disabled automatic extraction by default. It remains available as an
  opt-in sidecar writer once explicitly enabled, while normal memory changes
  remain model-tool or user-editor initiated.

## 0.2.28-rc8 - 2026-08-21

- Repaired legacy session-memory audit envelopes: historical extraction events
  written before they were explicitly ignorable can be normalized in place by
  the included repair script, with a full sibling backup before any rewrite.
  This prevents a strict RC8 session replay refusal from making an otherwise
  intact Memory Center document appear empty.
- Memory Center now excludes archived sessions from its selector immediately.
  Archiving is reversible: the underlying session and its personalization stay
  retained for an explicit DSH restore, but cannot be read, edited, or injected
  while archived.

## 0.2.27-rc8 - 2026-08-20

- Fixed session-identity drift in mission-bearing conversations. The scoped
  prompt assembly now replaces the Web deployment's “coding agent” persona
  with a capability-only statement while retaining the user-assigned identity
  as the single identity declaration.
- Strengthened the session identity contract across coding, research,
  administration, planning, and roleplay. Those modes are functions, not
  replacement personas.
- Added a compaction-continuity directive: checkpoints retain transient work
  state and must not restate, reinterpret, downgrade, or overwrite the active
  session identity.
- Clarified the documentation: DSH passes the current system context into its
  cache-aligned summarization call; this plugin directs the checkpoint not to
  persist independent identity and personalization layers.

## 0.2.26-rc8 - 2026-08-20

- Added a clean RC8 compatibility path: the bundle no longer patches absent
  in-tree memory rows, so an RC8 profile starts without stale-row warnings.
- Moved the session-specific compaction policy adapter into this package. It
  applies a temporary, serialized policy to the stock RC8 compaction service;
  no `compaction-basic`, bundle, Remote, or TypeScript source patch is needed
  in the Harness checkout.
- This compatibility line targets DeepSeek Harness `0.1.0-rc.8` and is tested
  from an isolated `DSH_HOME`; it must not be installed together with a legacy
  in-tree Mindspace memory implementation.

## 0.2.25 - 2026-08-20

- Re-enabled DSH's compaction engine and `/compact` command after the Web
  bundle overlay, so the per-session context-compaction policy is executed
  rather than merely saved by the Memory Center UI.
- Restored model autonomy for normal memory writes: the main model now decides
  whether stable information merits a tool call. The low-utilization automatic
  extractor skips a turn that already made a successful memory change.
- Reduced cold-start extraction output pressure: its audit list covers only
  durable proposed updates and permits an empty list for ordinary conversation.

## 0.2.24 - 2026-08-20

- Reframed automatic extraction as a cold-start fallback: it now runs only
  while the editable, persisted session-memory document is below 20% of its
  configured capacity. System prompts, RAG, compaction summaries, evidence,
  and event history are not counted.
- Raised the fallback extraction budget to 6000 tokens. Once the cold-start
  threshold is reached, only the primary model's explicit memory-tool decision
  can write memory.

## 0.2.22 - 2026-08-17

- Aligned the checked-in profile defaults with the runtime limits: three cards
  per editable card section and a 300-character user profile.
- Corrected the documented removal command to run through the official Harness
  checkout, matching installation and startup.

## 0.2.21 - 2026-08-16

- Rebased a stale editor save once onto the latest session document. Only the
  sections the user changed are applied; untouched sections retain concurrent
  extractor changes. A repeated conflict preserves the local draft.

## 0.2.20 - 2026-08-16

- Fixed legacy context-compaction policy replay so incomplete historical policy
  events are normalized before crossing the strict Typert result boundary.
- Memory Center now renders editable personalization data even if its separate
  compression-policy endpoint is temporarily unavailable.
- A stale whole-document save no longer retries an old complete document over
  newer memory.

## 0.2.12 - 2026-08-16

- Fixed duplicate Host Typert registration by using the documented manual
  `ctx.typert.register()` ownership for the package's hand-written strict wire
  schema and removing the competing automatic `./typert` loader export.

## 0.2.11 - 2026-08-16

- Fixed live Web upgrades: each strict generated Remote descriptor now mounts
  independently, so existing `get`/`replace` endpoints cannot block newly
  introduced compaction-policy methods.

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
