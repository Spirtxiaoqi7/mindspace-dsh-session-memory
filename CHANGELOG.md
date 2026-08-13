# Changelog

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
