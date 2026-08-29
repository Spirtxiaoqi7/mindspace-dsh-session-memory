# Mindspace Multi-Person Session Memory for DeepSeek Harness

<p align="center">
  <img src="assets/repository-logo.png" alt="Mindspace Session Memory" width="280">
</p>

An installable DeepSeek Harness community plugin for editable, session-isolated multi-person memory.

Version 0.5.0 promotes explicit AI requirements into the session-owned DSH persona section. They replace the Agent preset persona instead of being appended after it; when no requirements exist, the persona is empty. People and ordinary memories remain a separate contextual section.

## Why multi-person memory

A long-running agent should not treat the current `user` as its entire world. Conventional single-user memory keeps accumulating information about one speaker while the people, relationships, and judgments available to the model remain structurally narrow. Injecting an unrelated task may force renewed reasoning, but it also disrupts ongoing roleplay, work, or ordinary conversation.

Version 0.5.0 removes forced onboarding and empty-world prompt text. Only actual people, ordinary memories, and explicit requirements enter the model. Requirements occupy the persona layer; people and memories do not duplicate identity rules.

This is not conventional multi-character roleplay, nor does it require autonomous model-to-model chatter. Unsupervised AI-to-AI conversation can collapse into a self-narrating loop. The plugin keeps people in control while giving the agent a continuous world containing more than one real person. Multi-model interaction may be added later, but the design does not depend on it.

The model reads and writes through `get_session_memory` and `update_session_memory`. One read authorizes one classified mutation. Model-facing fields are rendered in Chinese as `人物一`, `个体名称`, `个体信息`, `人物偏好`, and `与当前 AI 的关系及背景`.

V1, V2, and V3 data migrates losslessly into the V4 sidecar format. The old user profile and preferences become person one, the old relationship becomes that person's relationship/background, and the old roleplay preset becomes an ordinary memory. Grandfathered text over the new 300-character edit limit is preserved until it is deliberately edited.

Memory remains outside the canonical conversation JSONL at `DSH_HOME/mindspace-session-memory/v1`. Automatic extraction is disabled by default. Session-scoped context-compaction controls remain available and isolated from the multi-person document.

## Install

```powershell
git clone https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory.git
Set-Location .\mindspace-dsh-session-memory
corepack pnpm install
corepack pnpm run check
$memoryTgz = (Get-ChildItem .\dist\mindspace-dsh-session-memory-0.5.0.tgz).FullName

Set-Location C:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add $memoryTgz
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
```

The plugin targets the DeepSeek Harness `0.1.1` compatibility line and owns the `mindspaceSessionMemory` Remote. Do not install it alongside a legacy embedded Mindspace Memory implementation.
Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

License: MIT.
