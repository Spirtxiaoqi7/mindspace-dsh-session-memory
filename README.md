# Mindspace Session Memory for DeepSeek Harness

<p align="center">
  <img src="assets/repository-logo.png" alt="DeepSeek whale community artwork" width="280">
</p>

An installable DeepSeek Harness community plugin for editable, session-isolated
personalization memory. It keeps continuity and user control in the same place:

- a roughly 300-character profile separating confirmed user facts from AI observations, while DSH compaction stays internal;
- editable preferences and assistant instructions consolidated into at most three categorized cards each;
- a relationship identity and a purpose for each conversation;
- an optional roleplay preset isolated to one session;
- model-facing `get_session_memory` and `update_session_memory` tools;
- conservative automatic extraction from explicit user statements;
- category-based conflict replacement with stable card ids and a visible append/merge/replace/skip audit trail;
- a one-time, optional role/purpose/style question when a new session has no personalization.

This is a community plugin and is not an official DeepSeek project. The repository
artwork is supplied by the project owner and is used only to identify this repository.

## Install

Prebuilt tarball or npm package (no install-time build permission):

```sh
dsh plugin --profile web add ./mindspace-dsh-session-memory-0.2.0.tgz
dsh --profile web --dump-config
dsh web
```

The repository deliberately does not expose an install-time build script. Install a
release tarball or npm artifact; a raw GitHub checkout is source for review and
development, not an installable prebuilt artifact.

## How it composes

The package is one DSH bundle with one dual-face row. On the Host it mounts the
memory service, projection, prompt contribution, model tools, extraction hook, and
Typert descriptor. The same package declares its Web client contribution, which
self-mounts the generated Remote descriptor and registers the settings page.

It does not patch DSH source, `api-remotes`, the built-in bundles, or root TypeScript
projects. Removal is therefore one command:

```sh
dsh plugin --profile web remove mindspace-dsh-session-memory
```

## Data and model calls

Memory changes are appended to the selected DSH session event log. The UI reads and
replaces a whole versioned document with optimistic revision checks. Automatic
extraction is enabled by default and may make one auxiliary model request after a
completed root-agent turn. A proposal must contain the complete next state plus a
handled/skipped ledger for every extracted atom; invalid or partial output is rejected
atomically. Confirmed facts and cautious observations remain separate, and inferred
sensitive facts are rejected by policy.

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
    extractionMaxTokens: 1024
```

## Compatibility

The initial release targets the public DeepSeek Harness `0.1.0-rc` family and Node
22.19+ or Node 24+. Harness is currently a developer preview; breaking upstream
changes may require a plugin update.

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
