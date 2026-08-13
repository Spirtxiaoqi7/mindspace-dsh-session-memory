# DeepSeek Harness 的 Mindspace 会话记忆插件

<p align="center">
  <img src="assets/repository-logo.png" alt="DeepSeek 鲸鱼社区图" width="280">
</p>

这是一个可安装的 DeepSeek Harness 社区插件，为每个会话提供隔离、可编辑、
可治理的个性化记忆：

- 以约 300 字的画像区分用户明确信息与 AI 观察，DSH 压缩保持内部运行；
- 用户偏好、对 AI 的要求各归纳为最多三张分类卡并可直接修改；
- 每个窗口可独立设置关系身份与窗口使命；
- 可选的扮演预设只注入当前会话；
- AI 可调用 `get_session_memory` 与 `update_session_memory` 主动读写；
- 从用户明确表达中保守抽取长期信息；
- 新信息按分类合并，明确纠正可稳定覆盖冲突信息且保留卡片 id；
- 最近整理记录显示来源消息、追加/合并/覆盖/跳过、前后值与原因；
- 新会话没有任何个性化时，只在首轮追加一次可选的身份/用途/风格询问。

本项目是社区插件，不属于 DeepSeek 官方项目。仓库图片由项目所有者提供，仅用于
标识本仓库。

## 0.2.0 更新与贡献

0.2.0 将首版“可编辑记忆”原型升级为 DeepSeek Harness 的会话级记忆治理层：

- 取消面向用户的压缩摘要覆盖，改为约 300 字的用户画像，并明确分开“用户确认”
  与“AI 观察”；
- 用户偏好和对 AI 的要求按主题归纳，每部分最多三张卡，避免长期记忆碎片化增长；
- 用户纠正信息时直接覆盖冲突内容，同时保持卡片 id 稳定；
- 自动抽取必须提交完整下一状态和逐信息 handled/skipped 清单，输出不完整时整批拒绝，
  不留下半份记忆；
- 最近整理记录展示新增、合并、覆盖、跳过以及来源消息、前后值、原因和时间；
- V1 会话事件仍可回放，并自动迁移到 V2 文档；
- 历史档案中的同名兜底分类会在回放时自动合并，不再锁死后续所有写入；
- AI 的名字、外号、自称和关系称谓使用专用身份动作，禁止写入用户画像或用户偏好；
- 关系使命和扮演预设继续按单个会话隔离。

本贡献保持 tree-out 组合方式：一个可安装的双面 DSH bundle 同时提供宿主侧服务、
事件投影、提示与工具接入、抽取钩子、Typert 描述符、Remote 和设置界面。它不替换
DSH 原有压缩语义，也不要求修改上游源码，因此这套记忆治理层可以独立安装、审计
和卸载。

### 已确认/AI 观察画像与分类偏好

<p align="center">
  <img src="assets/memory-center-v2-profile-preferences.png" alt="V2 用户画像与分类偏好" width="780">
</p>

### 会话角色预设与可见记忆审计

<p align="center">
  <img src="assets/memory-center-v2-role-audit.png" alt="V2 扮演预设与记忆整理审计" width="780">
</p>

V2 验收已通过 10 项自动化测试、构建与打包、真实模型写入/归并/覆盖、跨会话隔离，
以及默认 Web profile 重启后的持久化验证。

## 安装

安装预构建 tarball（无需授权安装脚本）：

```sh
dsh plugin --profile web add ./mindspace-dsh-session-memory-0.2.0.tgz
dsh --profile web --dump-config
dsh web
```

仓库刻意不提供安装时构建脚本。用户应安装 release tarball 或 npm 预构建产物；
GitHub 源码用于审查和开发，不作为可直接安装的预构建包。

## 组合方式

一个包只贡献一行，同时具有两面：宿主侧挂载记忆服务、投影、提示、模型工具、
抽取钩子和 Typert 描述符；同一包声明 Web 客户端贡献，自行挂载 Remote 描述符并
注册设置页。

它不修改 DSH 源码、`api-remotes`、官方 bundle 或根 tsconfig。卸载只需：

```sh
dsh plugin --profile web remove mindspace-dsh-session-memory
```

## 数据与模型调用

修改会追加到所选 DSH 会话的事件日志。界面用版本号进行乐观并发控制，避免静默
覆盖。自动抽取默认开启，根 Agent 一轮完成后可能额外发起一次模型请求；结果必须
包含完整状态和逐信息处理清单，否则整批拒绝，不会留下半份记忆。明确事实与谨慎
观察分开保存，敏感事实不得靠推测写入。

如只允许工具/人工写入，可在更后的 profile patch 中把 `autoExtract` 设为 `false`。

## 兼容性

首版面向公开的 DeepSeek Harness `0.1.0-rc` 系列以及 Node 22.19+ / Node 24+。
Harness 当前仍是开发者预览，上游破坏性修改可能需要同步更新插件。

## 开发

```sh
pnpm install
pnpm run build
pnpm test
pnpm pack --pack-destination dist
```

许可证：MIT。
