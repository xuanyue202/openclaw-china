# OpenClaw 渠道插件架构分析

## 1. 目的

本文基于 `doc/reference-projects/openclaw` 源码，分析 `telegram` 与 `feishu` 两个渠道的实现方式，提炼 OpenClaw 的渠道插件模型，为 `moltbot-china` 后续实现新渠道插件提供可复用的架构参考。

重点回答四个问题：

1. OpenClaw 宿主如何发现、加载、启动渠道插件。
2. 一个渠道插件最少需要承担哪些职责。
3. `telegram` 与 `feishu` 两种实现模式分别适合什么场景。
4. 我们在本仓库实现新渠道时，推荐采用什么目录结构和模块划分。

## 2. 核心结论

OpenClaw 的渠道体系本质上是一个“宿主负责生命周期，插件负责协议适配与消息语义”的分层模型。

可以把它拆成两层：

- 宿主层：插件发现、注册表、运行时能力注入、渠道启动/停止/重启、统一回复调度、统一路由与会话管理。
- 渠道层：账号配置、连接方式、入站事件监听、消息标准化、权限/配对/群策略、出站发送、健康探测、目录查询。

`telegram` 和 `feishu` 分别代表两种不同的插件实现风格：

- `telegram`：薄适配插件。插件本身很薄，主要把宿主内部已有的 Telegram 核心能力重新装配成 `ChannelPlugin`。
- `feishu`：完整自带实现插件。协议接入、事件处理、发送、工具扩展、目录能力几乎都在扩展包内部完成，只通过 `plugin-sdk` 使用宿主公共能力。

对我们最重要的启发是：

- 如果宿主已经有成熟的渠道内核，可以走 `telegram` 这种“包装型插件”。
- 如果是一个全新渠道，优先参考 `feishu` 这种“完整插件 + 只依赖宿主公共 runtime”的模式。

## 3. OpenClaw 宿主架构

### 3.1 插件发现与注册

关键文件：

- `src/plugins/loader.ts`
- `src/plugins/registry.ts`
- `src/plugins/runtime/index.ts`
- `src/plugins/runtime/runtime-channel.ts`

加载链路如下：

1. `loader.ts` 创建 `PluginRuntime`。
2. `loader.ts` 调用 `createPluginRegistry(...)` 创建运行期注册表。
3. 插件入口默认导出对象，`register(api)` 中调用 `api.registerChannel({ plugin })`。
4. `registry.ts` 把渠道插件记录到 `registry.channels`。
5. `plugins/runtime.ts` 把这个注册表设置为 active registry。
6. `src/channels/plugins/index.ts` 通过 active registry 对外提供 `getChannelPlugin()` / `listChannelPlugins()`。

这意味着：

- 插件本身不直接参与宿主主循环。
- 插件只需要“声明能力 + 提供适配器”。
- 宿主在真正发送消息、启动连接、执行登录、查看状态时，才按渠道 ID 取出插件并调用对应适配器。

### 3.2 渠道插件统一接口

关键文件：

- `src/channels/plugins/types.plugin.ts`
- `src/channels/plugins/types.adapters.ts`

`ChannelPlugin` 是渠道插件的统一契约。核心字段包括：

- `id` / `meta` / `capabilities`
- `config`
- `configSchema`
- `setup`
- `onboarding`
- `security`
- `groups`
- `outbound`
- `status`
- `gateway`
- `directory`
- `actions`
- `agentPrompt`
- `agentTools`

可以把这些字段理解为几个职责面：

- 配置面：`config`、`configSchema`、`setup`、`onboarding`
- 接入面：`gateway`
- 出站面：`outbound`
- 安全面：`security`、`groups`
- 可观测性：`status`
- 可发现性：`directory`
- 高级能力：`actions`、`agentTools`、`agentPrompt`

### 3.3 宿主注入给插件的公共能力

关键文件：

- `src/plugins/runtime/types-channel.ts`
- `src/plugins/runtime/runtime-channel.ts`
- `src/gateway/server-channels.ts`

宿主会通过 `PluginRuntime.channel` 暴露一批公共能力给插件，主要包括：

- `text`：分块、Markdown 表格处理、控制命令检测
- `reply`：统一回复调度、入站上下文标准化、AI 回复发送
- `routing`：路由到 agent/session
- `pairing`：配对申请和 allowFrom 存储
- `media`：拉取远程媒体、落盘
- `session`：记录会话状态与最近路由
- `debounce`：入站去抖
- `commands`：命令鉴权
- `groups`：群策略和 mention 策略

另外，宿主还把部分已有渠道实现以 helper 方式暴露出来，例如：

- `channel.telegram.*`
- `channel.discord.*`
- `channel.slack.*`

这就是 `telegram` 扩展为什么可以做得非常薄的原因。

### 3.4 渠道生命周期管理

关键文件：

- `src/gateway/server-channels.ts`

宿主侧由 `createChannelManager(...)` 统一管理渠道运行时，主要职责：

- 按账号枚举启动 `plugin.gateway.startAccount(...)`
- 在运行时状态中记录 `running / lastError / lastStartAt / lastStopAt`
- 账号级启停
- 自动重启与退避重试
- 热重载时按 `reload.configPrefixes` 判断哪些渠道需要重启

这说明插件无需自己设计“主进程级生命周期控制器”，只要：

- 提供 `startAccount`
- 正确响应 `abortSignal`
- 及时更新运行时状态

即可被宿主纳入统一管理。

## 4. Telegram 渠道架构

### 4.1 定位

关键文件：

- `extensions/telegram/index.ts`
- `extensions/telegram/src/channel.ts`
- `extensions/telegram/src/runtime.ts`
- `src/telegram/*`

`telegram` 扩展本身只有 3 个核心文件，说明它不是一个自带内核的完整扩展，而是对宿主已有 Telegram 能力的插件化封装。

它的基本做法是：

1. 插件入口把 `api.runtime` 保存到本地 `runtime.ts`。
2. `channel.ts` 定义 `telegramPlugin`。
3. 具体发送、探测、监控、消息动作等能力全部委托给 `getTelegramRuntime().channel.telegram.*`。

所以它的本质是：

- 配置、能力声明、账号管理放在插件层。
- Telegram 协议实现仍在宿主核心 `src/telegram/*` 中。

### 4.2 代码结构

`extensions/telegram` 的结构非常简单：

```text
extensions/telegram/
├── index.ts
├── openclaw.plugin.json
└── src/
    ├── channel.ts
    └── runtime.ts
```

真正的 Telegram 业务内核分布在宿主源码里：

```text
src/telegram/
├── accounts.ts
├── monitor.ts
├── send.ts
├── probe.ts
├── token.ts
├── audit.ts
├── bot.ts
└── ...
```

### 4.3 插件层职责

`telegramPlugin` 在插件层主要做了这些事情：

- 暴露 `meta`、`capabilities`
- 声明多账号配置与默认账号
- 处理 `allowFrom`、`dmPolicy`、群 mention 策略
- 实现 `setup` / `onboarding`
- 把 `outbound.sendText/sendMedia/sendPoll` 转发到 runtime helper
- 把 `status.probeAccount/auditAccount` 转发到 runtime helper
- 在 `gateway.startAccount` 中调用 `monitorTelegramProvider(...)`
- 处理 `logoutAccount`

也就是说，Telegram 插件更像一个“能力编排器”。

### 4.4 Telegram 适合借鉴的点

适合借鉴的不是它的目录复杂度，而是它的边界控制：

- 插件层只定义渠道契约，不重复实现底层 SDK/协议。
- 多账号解析、默认账号、allowFrom 标准化都放在统一适配层。
- `outbound` 与 `gateway` 是清晰分离的两个面。
- 渠道状态探测与运行时状态是分开的：`probe` 是主动检测，`runtime` 是当前运行状态。

### 4.5 Telegram 模式适用场景

当满足以下条件时，推荐类似 Telegram 的薄适配模式：

- 宿主已经有同渠道的成熟实现
- 插件化只是为了统一注册和热插拔
- 需要复用大量宿主内部 helper
- 不希望在扩展包里重复维护协议层代码

如果我们未来在 `moltbot-china` 内部沉淀出一套共享的飞书/企微/钉钉基础库，后续新插件也可以走这个方向。

## 5. Feishu 渠道架构

### 5.1 定位

关键文件：

- `extensions/feishu/index.ts`
- `extensions/feishu/src/channel.ts`
- `extensions/feishu/src/monitor.ts`
- `extensions/feishu/src/monitor.account.ts`
- `extensions/feishu/src/bot.ts`
- `extensions/feishu/src/reply-dispatcher.ts`
- `extensions/feishu/src/send.ts`
- `extensions/feishu/src/outbound.ts`

`feishu` 是一个完整的、自带渠道实现的扩展。它没有依赖宿主内部的 Feishu 核心模块，而是：

- 自己管理 Feishu SDK 客户端
- 自己监听 websocket/webhook
- 自己解析 Feishu 事件
- 自己处理媒体、话题、卡片、reaction、目录、文档工具
- 只通过 `plugin-sdk` 复用 OpenClaw 的通用能力

这是最适合我们参考的新渠道实现模板。

### 5.2 代码分层

`feishu` 扩展内部的分层非常清晰，可以概括成 6 层。

#### A. 入口层

- `index.ts`
- `openclaw.plugin.json`
- `package.json`

职责：

- 声明插件元信息
- 在 `register(api)` 中注册渠道
- 额外注册 doc/wiki/drive/perm/bitable 工具
- 保存 `api.runtime`

这里说明一个重要设计点：

- 渠道插件不一定只注册“聊天渠道”。
- 同一个扩展还可以顺带注册面向 agent 的渠道专属工具。

#### B. 配置与账号层

- `config-schema.ts`
- `accounts.ts`
- `types.ts`
- `secret-input.ts`

职责：

- 定义 schema
- 合并顶层配置与账号级配置
- 解析默认账号
- 把 top-level + account override 合成 `ResolvedFeishuAccount`
- 处理 secret 输入

这是一个很值得复用的模式：账号解析必须集中，不能散落在发送、监听、探测逻辑里。

#### C. 连接与传输层

- `client.ts`
- `monitor.ts`
- `monitor.account.ts`
- `monitor.transport.ts`
- `monitor.startup.ts`
- `monitor.state.ts`

职责：

- 创建缓存后的 Feishu REST client
- 创建 WS client / EventDispatcher
- 统一启动单账号或多账号 monitor
- 根据 `connectionMode` 在 websocket 和 webhook 之间切换
- 保存 webhook/连接状态
- 启动前预取 bot open_id

这里的架构特点非常明确：

- `monitor.ts` 负责总控
- `monitor.account.ts` 负责单账号事件绑定
- `monitor.transport.ts` 负责具体传输通道

这是非常适合我们直接借鉴的模块拆法。

#### D. 入站消息处理层

- `bot.ts`
- `card-action.ts`
- `mention.ts`
- `policy.ts`
- `dedup.ts`
- `typing.ts`
- `reply-dispatcher.ts`

职责：

- 把 Feishu 事件解析成统一上下文
- 做 mention 判断、@转发目标提取
- 做 dedupe、去抖、群/私聊权限判断、配对逻辑
- 解析引用消息、媒体消息、合并转发消息
- 组装给 agent 的标准化入站上下文
- 调用宿主 `routing` 和 `reply` 能力完成回复

这是 Feishu 架构的核心。

#### E. 出站层

- `outbound.ts`
- `send.ts`
- `media.ts`
- `send-target.ts`
- `targets.ts`
- `send-result.ts`
- `streaming-card.ts`

职责：

- 规范目标 ID
- 普通文本发送
- reply / thread reply
- 卡片发送和更新
- 图片/文件/媒体上传
- 流式卡片回复
- 根据 renderMode 决定用纯文本还是卡片

#### F. 扩展能力层

- `directory.ts`
- `probe.ts`
- `onboarding.ts`
- `chat.ts`
- `docx.ts`
- `drive.ts`
- `wiki.ts`
- `perm.ts`
- `bitable.ts`

职责：

- 健康探测
- 安装/向导配置
- 目录查询
- 飞书文档/知识库/权限等工具扩展

这说明 Feishu 插件不仅是“消息渠道”，还是一个“飞书平台集成扩展”。

### 5.3 Feishu 入站链路

Feishu 的消息处理链路可以概括为：

```text
monitorFeishuProvider
  -> monitorSingleAccount
    -> createEventDispatcher
      -> registerEventHandlers
        -> inboundDebouncer / per-chat queue
          -> handleFeishuMessage
            -> parseFeishuMessageEvent
            -> security/pairing/group policy
            -> resolveAgentRoute
            -> finalizeInboundContext
            -> createFeishuReplyDispatcher
            -> dispatchReplyFromConfig
```

这个链路有几个关键点。

#### 1. 先按 chat 串行，再做去抖

`monitor.account.ts` 里先构建 per-chat queue，再通过 `createInboundDebouncer(...)` 合并短时间内的连续文本消息。

好处：

- 同一会话消息顺序稳定
- 不同会话仍然可以并发
- 连发文本可以合并后再送入 agent，减少噪音和 token 消耗

#### 2. 渠道插件自己做消息语义标准化

`bot.ts` 会把 Feishu 原始事件映射为内部 `FeishuMessageContext`，包括：

- `chatId`
- `messageId`
- `senderOpenId`
- `chatType`
- `content`
- `rootId / parentId / threadId`
- `mentionedBot`
- `mentionTargets`

这一步非常关键。宿主不理解渠道原生事件，必须由插件负责把原始协议数据转成统一语义。

#### 3. 入站权限控制发生在路由前

Feishu 在真正路由给 agent 之前，会先完成：

- DM allowlist / pairing
- group allowlist
- sender allowlist
- requireMention

这是正确顺序。否则未授权消息也会污染 session 和 history。

#### 4. 会话 key 设计与群话题设计是插件核心能力

`resolveFeishuGroupSession(...)` 支持：

- `group`
- `group_sender`
- `group_topic`
- `group_topic_sender`

这说明群聊路由不是简单的“chatId 即 sessionId”，而是一个渠道级语义设计问题。

对任何新渠道来说，都必须在一开始明确：

- 一个 session 的粒度是什么
- 群、子话题、私聊、多成员上下文如何映射

#### 5. 回复不是直接 send，而是走宿主统一 reply runtime

Feishu 不自己调用 LLM，也不自己实现“回复决策”。它只负责：

- 构造 inbound context
- 创建本渠道 dispatcher
- 调用宿主 `reply.dispatchReplyFromConfig(...)`

这保证了：

- 不同渠道共享同一套 agent / routing / reply 管线
- 渠道只关心接入和投递

### 5.4 Feishu 出站链路

Feishu 的出站分为两层。

第一层是 `outbound.ts`，负责和宿主 `ChannelOutboundAdapter` 对接：

- `sendText`
- `sendMedia`
- `chunker`
- `textChunkLimit`

第二层是 `send.ts` / `media.ts`，负责直接访问 Feishu API。

这种拆法的好处是：

- `outbound.ts` 只关心“宿主给了我什么 payload”
- `send.ts` 只关心“如何调用渠道 API”

这是我们未来实现渠道插件时必须保持的边界。

### 5.5 Feishu 的高级设计亮点

#### 1. 多账号设计

`accounts.ts` 把：

- 顶层配置
- 账号级覆盖配置
- 默认账号选择

统一收敛成 `ResolvedFeishuAccount`。

这是成熟插件的标志。所有发送、监听、探测都只依赖 resolve 后的账号对象。

#### 2. WebSocket / Webhook 双模式

`monitor.transport.ts` 支持同一插件两种接入模式。

建议我们未来新渠道也尽量做成：

- transport 层可替换
- business handler 不依赖 transport

#### 3. 渠道专属回复调度器

`reply-dispatcher.ts` 处理：

- typing indicator
- streaming card
- replyTo / thread reply
- 文本/卡片/媒体混合发送

也就是说，统一 reply runtime 之上，渠道仍然可以有一层“投递策略适配器”。

#### 4. 插件内工具扩展

Feishu 在聊天渠道之外，还注册了 doc/wiki/drive/perm/bitable 工具。

这对我们有直接启发：

- 一个渠道扩展可以同时承担“消息渠道 + 平台工具箱”
- 如果未来做企业微信/钉钉，也可以把文档、审批、通讯录等工具一起作为同一插件输出

## 6. Telegram 与 Feishu 的对比

| 维度 | Telegram | Feishu |
| --- | --- | --- |
| 插件类型 | 薄适配 | 完整实现 |
| 运行时依赖 | 强依赖宿主内部 Telegram helper | 主要依赖 plugin-sdk 公共能力 |
| 目录复杂度 | 很低 | 很高 |
| 协议实现位置 | 宿主核心 `src/telegram/*` | 扩展内部 `extensions/feishu/src/*` |
| 适用场景 | 已有内核插件化 | 新渠道完整接入 |
| 可迁移性 | 较低，依赖宿主内部实现 | 较高，结构更完整独立 |
| 可作为新插件模板的价值 | 中 | 高 |

结论：

- 要理解 OpenClaw 的“插件边界”，看 `telegram`。
- 要实现一个新的企业级渠道插件，优先参考 `feishu`。

## 7. 对 `moltbot-china` 的落地建议

### 7.1 推荐采用 Feishu 风格的完整插件结构

对于新的中国区渠道插件，建议采用下面的目录分层：

```text
extensions/<channel-id>/
├── index.ts
├── openclaw.plugin.json
├── package.json
└── src/
    ├── channel.ts
    ├── runtime.ts
    ├── types.ts
    ├── config-schema.ts
    ├── accounts.ts
    ├── client.ts
    ├── targets.ts
    ├── monitor.ts
    ├── monitor.account.ts
    ├── monitor.transport.ts
    ├── inbound.ts
    ├── outbound.ts
    ├── send.ts
    ├── media.ts
    ├── policy.ts
    ├── onboarding.ts
    ├── probe.ts
    ├── directory.ts
    └── actions.ts
```

如果渠道有明显的企业平台能力，再额外扩展：

- `doc.ts`
- `drive.ts`
- `contacts.ts`
- `approval.ts`

### 7.2 推荐的模块职责

每个模块建议只做一类事情：

- `channel.ts`：组装 `ChannelPlugin`
- `runtime.ts`：保存 `api.runtime`
- `accounts.ts`：账号解析和配置继承
- `config-schema.ts`：Zod/JSON Schema
- `client.ts`：SDK client 和 cache
- `monitor*.ts`：连接与事件监听
- `inbound.ts` 或 `bot.ts`：消息标准化、路由前校验、上下文组装
- `outbound.ts`：适配宿主 outbound contract
- `send.ts`：直接调渠道 API
- `policy.ts`：群策略 / DM 策略 / allowlist
- `probe.ts`：健康检查
- `directory.ts`：会话目标查询

不要把这些逻辑混在一个 `channel.ts` 里。

### 7.3 MVP 阶段建议只做这些能力

第一版渠道插件建议只做：

1. 多账号配置解析
2. 入站文本消息接收
3. 出站文本发送
4. DM allowlist / pairing
5. 群消息基本策略
6. 健康探测
7. 基本 onboarding

第二阶段再做：

1. 媒体发送/接收
2. 线程/话题
3. reaction / typing
4. live directory
5. 平台专属 tools

### 7.4 新渠道必须优先设计的 5 个问题

在开工前先明确以下问题，否则后面会频繁返工：

1. 渠道 target 的标准格式是什么。
2. session key 按“私聊 / 群 / 群+人 / 群+话题”如何映射。
3. 是否有 replyTo / thread / topic 的原生能力。
4. DM 与群聊的授权模型分别是什么。
5. SDK/HTTP/Webhook/WS 哪种 transport 是主路径，是否需要双模式。

### 7.5 建议的实现顺序

推荐按下面顺序落地：

1. `types.ts` + `config-schema.ts`
2. `accounts.ts`
3. `client.ts`
4. `send.ts`
5. `outbound.ts`
6. `probe.ts`
7. `monitor.transport.ts`
8. `monitor.account.ts`
9. `inbound.ts` / `bot.ts`
10. `channel.ts`
11. `onboarding.ts`
12. `directory.ts`
13. `actions.ts` / 额外 tools

这个顺序的好处是：

- 可以先把“单向发送 + 健康检查”跑通
- 再接入入站事件
- 最后再做复杂的策略和增强能力

## 8. 需要特别注意的设计点

### 8.1 入站去重必须做持久化

Feishu 使用了内存 dedupe + 持久化 dedupe。这个设计非常合理，因为 webhook 重投、WS 重连、多账号重复投递都很常见。

新渠道插件建议至少做：

- 内存级 dedupe
- 重启后的短期持久化 dedupe

### 8.2 路由前过滤优先于会话记录

未授权消息、未 mention 的群消息、无效系统事件，不应该先进入 session/history，再决定忽略。

正确顺序应当是：

1. 标准化事件
2. 安全校验
3. 路由
4. 记录 session/history
5. 分发回复

### 8.3 出站层要处理宿主级 skip 语义

OpenClaw 的 reply dispatcher 可能产生 `empty`、`silent`、`heartbeat` 等 skip 情况。新渠道的 dispatcher/outbound 实现应明确哪些 payload 不应真正发送到用户侧。

### 8.4 transport 与业务逻辑分离

Webhook/WS 只负责“收到事件”，不要把业务判断写在 transport 层。Feishu 的 `monitor.transport.ts` 和 `monitor.account.ts` 分层值得直接照搬。

### 8.5 配置继承必须统一入口

顶层配置、默认账号、账号覆盖、环境变量、secret file，如果不统一在 `accounts.ts` 收敛，后续会在 send/monitor/probe 中出现大量分叉逻辑。

## 9. 最终建议

对 `moltbot-china` 来说，未来新增渠道插件时应默认采用下面的策略：

- 架构风格：优先参考 `feishu`，做完整插件。
- 宿主复用：只通过共享 runtime/helper 复用公共能力，不把渠道协议代码散落到宿主核心。
- 多账号：从第一版就按 `channels.<id>.accounts.<accountId>` 设计。
- 模块边界：配置解析、transport、inbound、outbound、probe、directory 分层实现。
- 演进路径：先做消息接入/发送，再逐步加媒体、线程、平台工具。

一句话总结：

`telegram` 适合拿来理解 OpenClaw 的插件接口；`feishu` 适合拿来作为我们实现新渠道插件的主参考模板。
