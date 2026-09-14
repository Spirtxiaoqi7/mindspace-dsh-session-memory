# Mindspace Memory for DeepSeek Harness

[中文](README.zh-CN.md) · Community plugin · MIT

**Separate work from everyday conversation. Maintain memory beyond context summaries.**

Chat and Work are two memory contexts for the same user and assistant, not two tool-permission presets. Each stores people, relationships, preferences, assistant identity, current state and lasting experiences.

## What's new in 0.7

- **Independent maintenance after compaction.** The main model can still write memory, but is no longer solely responsible for remembering. After successful compaction, a separate model call reconciles existing memory against the original conversation captured before summarization.
- **Updates instead of blind accumulation.** Maintenance adds durable omissions, corrects superseded facts and merges duplicates. Absence from recent conversation is not a deletion reason.
- **No shortest-card eviction.** Each card section supports up to 100 entries. Exceeding three entries no longer removes the shortest one.
- **Settings inheritance.** Create a blank session with the current Chat/Work memories, people, identity, bridge and compaction policy, without copying conversation history.
- **General current state.** Appearance or clothing may be described here, but is not a required dedicated feature.

## Interaction

Use the composer **Chat / Work** chip to express the current context. The model may also switch when the main intent changes. Modes never disable tools or alter permissions.

In **Settings → Personalization**, inspect/edit memory, inherit it into a new session, change the compaction policy or compact manually.

Cross-context facts are staged in a neutral bridge: a short transition note (up to 300 characters) plus pending write instructions. Only after entering the target mode does the model merge or dismiss each pending item.

## Maintenance lifecycle

Compaction captures the original textual conversation since the last successful compaction. On success, a separate request receives this evidence and current memory, then proposes source-linked operations. Long conversations are processed in ordered batches rather than truncated.

Memory revisions are checked before applying changes. Concurrent edits cause a retry against the latest state; cross-mode changes remain staged. Failed calls preserve memory and task evidence, with up to three attempts per batch. Background maintenance does not block ordinary conversation.

This incurs additional model usage after compaction, not after every turn. Empty provider/model settings reuse the session route; a dedicated lower-cost model can be selected. No tools are supplied to the maintenance call. Model judgments can still be corrected in the Memory Center.

## Configuration

Override the installed bundle in your Web profile's `cordis.patch.yml`:

```yaml
- id: mindspace-session-memory
  config:
    maxTextBytes: 4096
    maxItemsPerSection: 100
    maxProfileCharacters: 300
    maintenanceEnabled: true
    maintenanceProvider: ''
    maintenanceModel: ''
    maintenanceMaxTokens: 6000
```

Restart after configuration changes. Compaction enablement/thresholds are per-session; maintenance configuration is plugin-wide. Successful manual compaction also triggers maintenance.

## Compatibility and migration

Version **0.7 targets DSH 0.1.5-rc.2 and the corresponding 0.1.x APIs**. Keep plugin 0.6.10 on the older 0.1.1 core until upgrading DSH.

Storage remains under `DSH_HOME/mindspace-session-memory/v1`; the directory name is not the document format version. V5 Chat/Work documents remain unchanged. Existing V1–V4 data is read through the migration path into Chat without inventing a Work persona. Legacy memory events can still be imported; new memory writes remain outside canonical session logs.

Maintenance tasks and original evidence live in `DSH_HOME/mindspace-session-memory/maintenance`. These are local user data, not repository artifacts. Back up DSH_HOME before upgrading. DSH handles its own session-format migration; use the matching pre-upgrade backup when rolling back.

## Install from source

```powershell
git clone https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory.git
Set-Location .\mindspace-dsh-session-memory
corepack pnpm install
corepack pnpm run check
$memoryTgz = (Get-Item .\dist\mindspace-dsh-session-memory-0.7.0.tgz).FullName
Set-Location C:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add $memoryTgz
corepack pnpm dsh web
```

No DSH core patch is required. Do not load a duplicate legacy implementation alongside this plugin. Manual edits, model writes and maintenance share the same storage and revision path.

See [CHANGELOG](CHANGELOG.md). This is not an official DeepSeek project.
