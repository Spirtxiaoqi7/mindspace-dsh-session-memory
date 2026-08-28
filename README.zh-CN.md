# DeepSeek Harness 的 Mindspace 多人物会话记忆

这是一个可安装的 DeepSeek Harness 社区插件。0.4.1 将单一用户画像升级为按会话隔离、可编辑的多人物记忆，让 AI 记住的不只是当前发言者，也包括真实出现在这段关系与生活中的其他人物。

## 为什么改成多人物记忆

长期智能体不应把当前 `user` 当作整个世界。传统单用户记忆越积越多，模型接触到的人物、关系与判断依据却仍然只围绕一个发言者收束；想让它重新思考时，若直接插入无关任务，又会破坏正在进行的角色扮演、工作或日常交流。

0.4.1 选择改变“人物世界”，而不是强行改变当前任务：把真实出现过的人分别保存为独立人物，使新的关系信息能够在尽量不打断原任务的情况下，引入对“正在涉及谁、该如何理解、这件事能不能做”的重新判断。人物一只是当前发言者，不再被描述成唯一主体；最多五个人物都可以拥有自己的信息、偏好，以及与当前 AI 的关系和背景。

这不是传统的多角色扮演，也不要求多个模型自动互聊。无人控制的 AI—AI 对话很容易形成自我叙述循环；本插件保留人的控制权，只为 AI 提供一个可以容纳更多真实人物的连续世界。未来可以接入多模型协作，但系统获得人物多样性并不依赖它。

## 0.4.1 的记忆结构

- **人物信息**：最多 5 人。人物一对应当前发言者，但不是 AI 世界里唯一的人。每人拥有稳定 id、个体名称和最多 300 字的个体信息；同名人物不会被自动合并。
- **人物偏好**：与人物列表严格对齐，每人一段、最多 300 字。
- **对 AI 的要求**：最多 3 个归纳组，只记录明确的必须、应该、不要、禁止和稳定互动规则。
- **人物之间关系**：分别描述每个人物与当前 AI 的关系及背景，允许随互动发展、减弱或结束。
- **记忆**：最多 3 个普通记忆组，可记录值得延续的事件与背景，不再限定为扮演预设，也没有启用开关。

模型可通过 `get_session_memory` 与 `update_session_memory` 主动读写。一次读取只授权一次分类更新；下一次写入前必须重新读取，从而避免用旧状态覆盖人工或其他轮次的修改。提示词使用中文字段 `人物一`、`个体名称`、`个体信息`、`人物偏好`、`与当前 AI 的关系及背景`。

## 数据迁移

侧车格式升级为 4。第一次读取旧数据时会自动迁移：

- V1/V2/V3 的用户画像、待确认信息、偏好与关系合并到人物一；
- 旧扮演预设进入普通“记忆”；
- 旧对 AI 要求继续保留；
- 旧数据即使超过新的 300 字编辑上限也不会被迁移过程截断；只有新建或实际编辑后的字段执行新上限。

数据仍保存在 `DSH_HOME/mindspace-session-memory/v1` 下按会话隔离的原子侧车文件中，不改写 DSH 原始会话 JSONL。自动抽取默认关闭；默认由模型工具或记忆中心人工编辑。

## 会话级上下文压缩

记忆中心顶部继续提供按会话隔离的自动压缩阈值、末尾原文保留量、摘要上限和“立即压缩”按钮。压缩策略独立保存，不会把人物、要求和普通记忆并入摘要，也不会影响其他会话。

## 安装

```powershell
git clone https://github.com/Spirtxiaoqi7/mindspace-dsh-session-memory.git
Set-Location .\mindspace-dsh-session-memory
corepack pnpm install
corepack pnpm run check
$memoryTgz = (Get-ChildItem .\dist\mindspace-dsh-session-memory-0.4.1.tgz).FullName

Set-Location C:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add $memoryTgz
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
```

不要在插件目录执行 `pnpm dsh`。插件面向 DeepSeek Harness `0.1.1` 兼容线，独占 `mindspaceSessionMemory` Remote，不应与旧的内嵌 Mindspace Memory 同时安装。

## 默认配置

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

## 开发

```powershell
pnpm install
pnpm run build
pnpm test
pnpm pack --pack-destination dist
```

本项目是社区插件，不属于 DeepSeek 官方项目。许可证：MIT。
