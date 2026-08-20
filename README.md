# Mindspace Session Memory for DeepSeek Harness

<p align="center">
  <img src="assets/repository-logo.png" alt="DeepSeek whale community artwork" width="280">
</p>

An installable DeepSeek Harness community plugin for editable, session-isolated
personalization memory. It keeps continuity and user control in the same place:

- a roughly 300-character profile separating confirmed user facts from AI observations, while DSH compaction stays internal;
- editable preferences and assistant instructions consolidated into at most three categorized cards each;
- a relationship identity and a purpose for each conversation;
- an identity-continuity guard: a session mission remains the model's identity
  while coding and other work are capabilities, rather than competing personas;
- an optional roleplay preset isolated to one session;
- model-facing `get_session_memory` and `update_session_memory` tools;
- conservative automatic extraction from explicit user statements;
- category-based conflict replacement with stable card ids and a visible append/merge/replace/skip audit trail;
- a one-time, optional role/purpose/style question when a new session has no personalization.

## 0.2.27-rc8: Identity continuity across work and compaction

When a session has an explicit relationship/mission, it now supplies the only
identity declaration for that agent scope. The Web deployment's former
“coding agent” persona is replaced in that scope by a role-neutral statement
of available Harness capabilities. Sessions without a mission retain the
ordinary Harness persona unchanged.

- Coding, research, planning, administration, and roleplay are explicitly
  framed as ways to carry out the session mission, never an identity switch.
- The same identity section instructs compaction to retain transient task and
  conversational state only. It must not turn the identity into a historical
  “user request”, repeat it, or overwrite it in a checkpoint.
- This changes prompt composition only. Harness tool availability, sandbox,
  approvals, and safety policy are not weakened or replaced.

## 0.2.9: Session-scoped context compaction

The Memory Center now exposes a session-isolated context-compaction policy. Users can
enable it, set the trigger ratio, retained recent context, and summary limit, or run a
manual compaction before the threshold is reached. The policy is persisted as session
events and never changes another conversation.

- The conversation surface is condensed while the summarizer still receives
  the current system context for cache alignment. The session identity
  explicitly instructs it not to copy, reinterpret, or overwrite identity,
  profile, relationship, or roleplay state in a checkpoint.
- The prior summary is included as input to avoid losing durable context across
  repeated compactions.
- The compaction prompt prioritizes facts, decisions, constraints, open work,
  and reusable conclusions while dropping greetings, repetition, and tool logs.
- DSH remains the compaction executor; this plugin supplies the session policy
  and the visible user controls.

This is a community plugin and is not an official DeepSeek project. The repository
artwork is supplied by the project owner and is used only to identify this repository.

## 0.2.0 update and contribution

Version 0.2.0 turns the first editable-memory prototype into a governed,
session-scoped personalization layer for DeepSeek Harness:

- the public compaction-summary override is replaced by a 300-character user profile
  that separates confirmed facts from clearly labelled AI observations;
- preferences and assistant requirements are consolidated into at most three
  categorized cards per section instead of growing as disconnected fragments;
- corrections replace conflicting information while preserving stable card ids;
- automatic extraction proposes a complete next state and an atom-by-atom
  handled/skipped ledger, so partial model output is rejected atomically;
- append, merge, replace, and skip activity records expose source message sequences,
  before/after values, reasons, and timestamps;
- V1 session events remain replayable and migrate into the V2 document shape;
- repeated legacy fallback categories are repaired during replay instead of locking all later writes;
- assistant names, nicknames, self-designations, and relationship-specific titles have a dedicated
  identity action and are never routed into the user's profile or preferences;
- relationship missions and roleplay presets remain independently scoped to each
  conversation.

The contribution is deliberately tree-out: one installable dual-face DSH bundle owns
the Host service, event projection, prompt/tool integration, extraction hook, Typert
descriptor, Remote, and settings UI. It does not replace DSH compaction semantics or
require an upstream source patch, making the memory-governance layer independently
installable, auditable, and removable.

### Confirmed/observed profile and categorized preferences

<p align="center">
  <img src="assets/memory-center-v2-profile-preferences.png" alt="V2 profile and categorized preference cards" width="780">
</p>

### Session role preset and visible memory audit

<p align="center">
  <img src="assets/memory-center-v2-role-audit.png" alt="V2 role preset and memory activity audit" width="780">
</p>

The V2 acceptance run passed 10 automated tests, build and package checks, real model
write/merge/replace flows, cross-session isolation, and persistence after restarting
the default Web profile.

## Install

This README describes current `main`. It does not point at a nonexistent Release
tarball: build the prebuilt package from a pulled checkout, then install it from
the **official Harness checkout root**.

```powershell
git clone https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory.git
Set-Location .\mindspace-dsh-session-memory
corepack pnpm install
corepack pnpm run build
corepack pnpm pack --pack-destination dist
$memoryTgz = (Get-ChildItem .\dist\mindspace-dsh-session-memory-*.tgz | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName

Set-Location C:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add $memoryTgz
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
```

Do not run `pnpm dsh` in the plugin directory or require a global `dsh`: that
command belongs to the official Harness checkout. The repository has no
install-time build script; the commands above explicitly create and install the
tarball. Historic GitHub Releases map only to their respective tags and do not
represent the current `main` feature set.

## How it composes

The package is one DSH bundle with one dual-face row. On the Host it mounts the
memory service, projection, prompt contribution, model tools, extraction hook, and
Typert descriptor. The same package declares its Web client contribution, which
self-mounts the generated Remote descriptor and registers the settings page.

It does not patch DSH source, `api-remotes`, the built-in bundles, or root TypeScript
projects. Removal is therefore one command:

```sh
corepack pnpm dsh plugin --profile web remove mindspace-dsh-session-memory
```

## Data and model calls

Memory changes are appended to the selected DSH session event log. The UI reads and
replaces a whole versioned document with optimistic revision checks. Automatic
extraction is a cold-start fallback: it may make one auxiliary model request after a
completed root-agent turn only while editable memory utilization is below 20%, and
skips a turn that already made a model-owned memory-tool write. Above that threshold,
the primary model alone decides whether to use the memory tools.
System prompts, RAG, compaction summaries, and event history are not counted. The
auxiliary budget defaults to 6000 tokens. A proposal must contain the complete next
state plus a handled/skipped ledger for every extracted atom; invalid or partial output
is rejected atomically. Confirmed facts and cautious observations remain separate, and
inferred sensitive facts are rejected by policy.

Disable automatic extraction in a later profile patch if you want tool/manual writes
only:

```yaml
- id: mindspace-session-memory
  name: mindspace-dsh-session-memory
  config:
    maxTextBytes: 4096
    maxItemsPerSection: 3
    maxProfileCharacters: 300
    autoExtract: false
    autoExtractBelowUtilization: 0.2
    extractionMaxTokens: 6000
```

## Compatibility

The initial release targets the public DeepSeek Harness `0.1.0-rc` family and Node
22.19+ or Node 24+. Harness is currently a developer preview; breaking upstream
changes may require a plugin update.

The RC8 compatibility line is tested against DeepSeek Harness `0.1.0-rc.8` in
an isolated profile. It owns the distinct `mindspaceSessionMemory` Remote and
does not patch or disable in-tree memory rows. The session compaction controls
are applied through a plugin-owned adapter around the stock compaction service,
so the Harness checkout remains unmodified. Do not install it together with a
legacy in-tree Mindspace memory implementation: migration keeps one owner for
each session-memory schema and Remote namespace.

## Development

```sh
pnpm install
pnpm run build
pnpm test
pnpm pack --pack-destination dist
```

The generated Typert descriptors are committed under `src/generated/`. The build
rescopes their package identity and bundles the browser Remote with the UI.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

## License

MIT
