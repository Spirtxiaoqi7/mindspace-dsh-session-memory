# Mindspace Chat / Work Session Memory for DeepSeek Harness

<p align="center">
  <img src="assets/repository-logo.png" alt="Mindspace Session Memory" width="280">
</p>

An installable DeepSeek Harness community plugin that gives the same user and AI two task-conditioned memory faces:

- **Chat** — daily identity, relationships, preferences, long-term experiences, and the AI's current appearance.
- **Work** — project identity, collaboration relationships, engineering preferences, project state, and work requirements.

The selected face changes prompt context and the write destination. It never disables tools or changes permissions. The model may route between faces from the latest intent, while the composer chip lets the user express a strong current preference.

## Neutral bridge

Cross-domain facts do not write directly into the inactive face. They enter a small neutral bridge containing only:

1. a transition note of at most 300 characters;
2. pending cross-domain write instructions.

After entering the target face, the model reviews each pending item, consolidates it into target memory or skips it, and clears only the resolved item. The bridge is not a third long-term memory.

Model operations are exposed through `route_session_memory`, `get_session_memory`, `update_session_memory`, and `resolve_pending_memory`. The Memory Center uses the same sidecar and Remote rather than maintaining a second implementation.

Explicit user-confirmed changes to people, relationships, stable preferences, AI instructions, or the AI's current state are written in the same turn. Current Chat appearance and Work role/state use dedicated one-call actions; ordinary small talk and momentary actions remain outside long-term memory.

Memory remains session-isolated under `DSH_HOME/mindspace-session-memory/v1` and does not rewrite canonical conversation JSONL. Existing V1–V4 business data migrates into Chat without being copied into Work. Session-scoped context compaction reuses DSH's stock engine and `/compact` command. The Memory Center shows the selected model's effective pressure, trigger line, retained tail, and latest result; policy changes can be applied without saving unrelated memory fields.

## Install

```powershell
git clone https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory.git
Set-Location .\mindspace-dsh-session-memory
corepack pnpm install
corepack pnpm run check
$memoryTgz = (Get-ChildItem .\dist\mindspace-dsh-session-memory-0.6.4.tgz).FullName

Set-Location C:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add $memoryTgz
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
```

The plugin targets the DeepSeek Harness `0.1.1` compatibility line and owns the `mindspaceSessionMemory` Remote. Do not install it alongside a legacy embedded implementation.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

License: MIT.
