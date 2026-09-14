# Mindspace Memory：日常与工作分开，记忆持续维护

[English](README.md) · DeepSeek Harness 社区插件 · MIT

同一个人有工作和生活，同一个对话助手也不必把所有经历混在一起。Memory 根据当前情境加载 Chat 或 Work 记忆，同时让长期记忆在上下文压缩后得到独立维护。

## 0.7 的变化

- **Chat / Work**：分开保存人物信息、关系、偏好、AI 自述、当前状态、长期经历和要求。衣着只是当前状态的一种内容，不是必须填写的专门功能。
- **主动写入 + 后台整理**：保留模型的记忆工具。压缩成功后额外调用一次整理流程，不再只依赖主对话模型主动记忆。
- **压缩与整理分开**：压缩负责精简近期对话；整理读取已有长期记忆和压缩前的原文证据，增加遗漏、修正过时内容、合并重复。不会因为最近没提到某件事就删掉它。
- **不再按长度淘汰**：超过三组不再替换最短记忆。每个模式的每个卡片栏目最多 100 组；合并以语义为依据。
- **设定继承**：点击后创建空白会话，复制两种模式、人物、设定、记忆、桥接和压缩策略，不复制旧聊天记录。后续修改彼此独立。

## 怎么使用

在输入框用 **Chat / Work** 按钮表达当前情境。模型发现主要意图改变时也可以切换；按钮不是永久锁。模式只改变记忆注入和写入目标，**不限制工具能力或权限**。

打开 **设置 → 个性化** 可以检查、修改或继承当前会话的记忆，调整自动压缩比例，或者点击“立即压缩当前会话”。

跨域信息先进入中立桥：最多 300 字的转场说明，以及待写入目标模式的说明。切换后再由模型审阅、合并或跳过，处理完成才清空。Chat 不直接写入 Work，反之亦然。

## 后台整理怎样工作

1. DSH 开始压缩时，保存自上次成功压缩以来的原始文字对话，不使用新摘要代替原文。
2. 压缩成功后，独立调用配置的模型，结合现有记忆提出带来源序号的增删改操作。
3. 写回前检查记忆修订号；若用户或主模型已经修改，重新基于最新记忆整理。跨域操作仍进入桥接。
4. 失败保留原有记忆和任务记录，每个批次最多尝试三次。长原文按顺序分批，正常短对话通常只需一次调用；不会截掉早期内容。
5. 任务和证据保存在本地。主会话可以继续，下一步注入会使用已完成写回的记忆。

整理会产生额外模型费用，不是每轮都调用。默认复用当前会话的 provider/model，也可以指定较便宜的专用模型。整理调用不提供工具，不代替主对话执行任务。用户明确要求不保存的内容不应被纳入长期记忆；模型判断仍可能出错，用户可以在记忆中心纠正。

## 配置

安装后，在 Web profile 的 `cordis.patch.yml` 中覆盖以下配置：

```yaml
- id: mindspace-session-memory
  config:
    maxTextBytes: 4096
    maxItemsPerSection: 100
    maxProfileCharacters: 300
    maintenanceEnabled: true
    maintenanceProvider: ''  # 空值：沿用会话 provider
    maintenanceModel: ''     # 空值：沿用会话 model
    maintenanceMaxTokens: 6000
```

修改配置后重启 DSH。自动压缩是否开启和阈值是**会话级设置**；后台整理开关是**插件级设置**。关闭自动压缩不删除手动压缩按钮，手动压缩成功也会触发整理。

## 兼容与迁移

**0.7 面向 DSH 0.1.5-rc.2 及相应 0.1.x 接口，不支持直接装入旧的 0.1.1 核心。** 核心较旧时先升级 DSH，或继续使用插件 0.6.10。

数据仍位于 `DSH_HOME/mindspace-session-memory/v1`。目录名不是业务格式版本：
- 现有 V5 的 Chat / Work 文档保持原样，不重新生成身份。
- 旧 V1–V4 由现有迁移器读取到新版结构，既有内容进入 Chat，不凭空复制一份到 Work。
- 旧会话日志中的记忆记录仍可导入；插件的新记忆写入使用侧车文件，不把私有事件塞进 DSH 会话日志。
- 新增 `DSH_HOME/mindspace-session-memory/maintenance` 保存整理任务、原文证据及错误信息。它属于本地会话数据，不应随插件源码公开。

升级前备份 DSH_HOME。核心会话格式升级由 DSH 自己负责；回退时使用对应版本及升级前备份，不应让旧核心写入新版转换后的日志。

## 安装与开发

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

插件是独立安装包，无需修改 DSH 核心。不要与同名的旧内嵌记忆实现同时加载。模型写入、后台整理、手动编辑共用同一套存储和修订逻辑。

详见 [更新记录](CHANGELOG.md)。
