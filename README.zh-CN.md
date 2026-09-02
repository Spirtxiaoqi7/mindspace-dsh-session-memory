# DeepSeek Harness 的 Mindspace Chat / Work 会话记忆

这是一个可安装的 DeepSeek Harness 社区插件。它把同一个用户、同一个 AI 在不同任务状态下的记忆分成两个面：

- **Chat（日常）**：用户信息、AI 设定、双方关系、日常偏好、长期经历，以及 AI 当前衣着与外观。
- **Work（工作）**：工作身份、AI 工作设定、协作关系、工程偏好、项目状态、长期工作记忆与工作要求。

模式只决定本轮注入哪组记忆、写回哪个位置，不限制工具和权限。模型可以根据最新意图切换；输入框按钮则让用户直接表达当前偏好。用户选择是强信号，但不会阻止模型在任务性质已经改变时重新判断。

## 中立桥接层

当前模式发现另一模式的信息时，不会越级写入。它只会放进中立桥的两个槽位：

1. 最多 300 字的转场说明；
2. 等待目标模式处理的跨域写入说明。

进入目标模式后，模型逐条审阅待办：合并到目标记忆或明确跳过；只有完成处理的项目会被清除。桥接层不是第三套长期记忆，也不保存 Chat 或 Work 的详细内容。

模型通过 `route_session_memory`、`get_session_memory`、`update_session_memory` 和 `resolve_pending_memory` 完成路由、读取、暂存与消费。输入框模式按钮和设置中的记忆中心使用同一套侧车与 Remote，没有另造一套状态。

数据按会话隔离，保存在 `DSH_HOME/mindspace-session-memory/v1`，不改写 DSH 原始会话 JSONL。V1–V4 的既有业务数据首次读取时完整迁入 Chat，Work 保持空白，避免凭空复制工作身份。会话级上下文压缩继续独立保存。

## 配置

```yaml
- id: mindspace-session-memory
  name: mindspace-dsh-session-memory
  config:
    maxTextBytes: 4096
    maxItemsPerSection: 3
    maxProfileCharacters: 300
```

## 安装

```powershell
git clone https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory.git
Set-Location .\mindspace-dsh-session-memory
corepack pnpm install
corepack pnpm run check
$memoryTgz = (Get-ChildItem .\dist\mindspace-dsh-session-memory-0.6.1.tgz).FullName

Set-Location C:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add $memoryTgz
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
```

不要在插件目录执行 `pnpm dsh`。插件面向 DeepSeek Harness `0.1.1` 兼容线，独占 `mindspaceSessionMemory` Remote，不应与旧的内嵌实现同时安装。

## 开发

```powershell
pnpm install
pnpm run check
pnpm pack --pack-destination dist
```

本项目是社区插件，不属于 DeepSeek 官方项目。许可证：MIT。
