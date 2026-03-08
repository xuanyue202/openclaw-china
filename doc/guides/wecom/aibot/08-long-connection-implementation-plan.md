# 企业微信智能机器人长连接接入实现方案

## 1. 目标

本文基于以下两部分信息整理：

- 本地文档 `智能机器人长连接 - 文档 - 企业微信开发者中心.cleaned.html`
- 当前实现目录 `extensions/wecom`

目标不是直接写代码，而是明确说明：

- 当前 `wecom` 插件的结构与耦合点
- 企业微信“智能机器人长连接”与当前 webhook 实现的关键差异
- 在**不复制新插件目录**的前提下，如何在 `extensions/wecom` 内新增长连接模式
- 推荐的模块拆分、配置方案、实现顺序、测试范围与风险

结论先行：

- **建议继续使用 `extensions/wecom` 作为唯一插件目录**
- **建议在同一插件内新增 `mode: "ws"`，保留现有 `mode: "webhook"`**
- **不建议复制一份 `wecom-ws` 新插件**

原因很简单：两者都属于“企业微信智能机器人”，差异在传输协议，不在产品语义。

## 2. 当前 `extensions/wecom` 的实现结构

### 2.1 入口层

`extensions/wecom/index.ts` 当前做了两件事：

- 注册 `wecom` channel
- 注册 HTTP 路由，把请求交给 `handleWecomWebhookRequest`

这说明当前插件是**以 webhook/回调模式为中心**设计的。

另外，入口还统一注册了 `/wecom-media` 相关路由，用于临时文件公网访问。

### 2.2 配置层

`extensions/wecom/src/config.ts` 和 `extensions/wecom/src/types.ts` 当前只支持 webhook 所需配置：

- `webhookPath`
- `token`
- `encodingAESKey`
- `receiveId`
- `welcomeText`
- DM / 群策略

`ResolvedWecomAccount` 也只解析 webhook 所需凭证。  
当前没有任何 `botId`、`secret`、`mode`、`wsUrl`、心跳或重连配置。

### 2.3 ChannelPlugin 层

`extensions/wecom/src/channel.ts` 当前承担了三个职责：

- 目标解析与目录能力
- 出站消息接口
- 账号 gateway 生命周期

其中出站行为非常关键：

- `sendText` / `sendMedia` 只会向“当前活动 stream”追加内容
- `sendTemplateCard` 依赖 `response_url`
- `gateway.startAccount` 只会注册 webhook target，并等待 `abortSignal`

这意味着当前 `wecom` 的出站模型不是“随时主动发消息”，而是：

- **消息回复依赖 webhook 回调建立的上下文**
- **文本/媒体回复依赖 stream 轮询模型**
- **模板卡片依赖单次 `response_url`**

### 2.4 Webhook transport 层

`extensions/wecom/src/monitor.ts` 是当前实现里最重的文件。它同时做了：

- webhook target 注册
- HTTP GET/POST 处理
- 签名校验与密文解密
- XML/JSON 解析
- stream 状态管理
- 首次 HTTP 应答占位
- 后续 stream 刷新响应
- 回调消息分发到 `dispatchWecomMessage`

也就是说，`monitor.ts` 目前把**协议层、传输层、回复状态层**都揉在了一起。

这是当前支持长连接的最大结构性阻碍。

### 2.5 公共业务分发层

`extensions/wecom/src/bot.ts` 是当前最值得复用的部分。它负责：

- 把入站消息转成 OpenClaw 可消费的上下文
- 做 DM / 群策略判定
- 调用 `resolveAgentRoute`
- 记录 session / lastRoute
- 通过 `dispatchReplyWithBufferedBlockDispatcher` 把 agent 产出转成分块回复
- 把图片/文件/语音下载到本地并转成文本引用

这里本质上是**业务分发管道**，与具体是 webhook 还是 WebSocket 没有强耦合。

### 2.6 出站辅助层

`extensions/wecom/src/outbound-reply.ts` 目前包含两类能力：

- `response_url` 缓存
- 本地临时文件公网暴露服务 `/wecom-media`

其中：

- `response_url` 是 webhook 特有能力
- `/wecom-media` 临时文件服务在长连接模式下仍然可复用

### 2.7 加解密层

`extensions/wecom/src/crypto.ts` 当前做了两类不同事情：

- webhook 消息包的签名、加解密
- 媒体文件 AES 解密

这里有一个很重要的差异：

- webhook 模式下，媒体解密依赖 `encodingAESKey`
- 长连接文档里，`image` / `file` 使用的是**每个 URL 独立返回的 `aeskey`**

所以当前媒体解密代码不能原样复用，必须抽象成“通用 AES 媒体解密”，而不是继续绑定 `encodingAESKey`。

## 3. 长连接文档给出的协议要求

根据本地文档，长连接模式的关键约束如下。

### 3.1 建链与鉴权

- WebSocket 地址：`wss://openws.work.weixin.qq.com`
- 建链后先发 `aibot_subscribe`
- 鉴权字段为 `bot_id + secret`
- 一个机器人同一时间只能保持一条有效长连接
- 新连接成功后会踢掉旧连接

### 3.2 入站回调

企业微信通过同一条 WebSocket 推送：

- `aibot_msg_callback`
- `aibot_event_callback`

关键上下文字段：

- `headers.req_id`
- `body.msgid`
- `body.chatid`
- `body.chattype`
- `body.from.userid`
- `body.msgtype`

### 3.3 出站命令

长连接下不是回 HTTP 响应体，而是通过同一条 WebSocket 主动发送命令：

- `aibot_respond_welcome_msg`
- `aibot_respond_msg`
- `aibot_respond_update_msg`
- `aibot_send_msg`
- `ping`

### 3.4 流式回复模型

长连接与当前 webhook 实现最大的协议差异是：

- **不再有 HTTP 回调轮询 stream 刷新**
- 开发者要主动通过 WebSocket 推送 `aibot_respond_msg`
- 同一次消息回调的所有流式刷新都要复用相同 `req_id`
- 用 `stream.id` 标识同一条流式消息

这和当前 `wecom` 插件“stream-first”的 OpenClaw 回复组织方式其实是契合的，但 transport 实现必须重写。

### 3.5 时效与额度约束

文档明确写了：

- `enter_chat` 欢迎语回复：5 秒内
- `template_card_event` 卡片更新：5 秒内
- 流式消息：6 分钟内必须 `finish=true`
- 收到消息回调后：24 小时内每会话 30 条回复额度
- 主动推送：每自然日每会话 10 条

### 3.6 媒体处理约束

长连接文档当前明确写了：

- `image` / `file` 返回 `url + aeskey`
- URL 5 分钟有效
- 解密方式：`AES-256-CBC`
- PKCS#7 填充到 32 字节倍数
- IV 取 `aeskey` 前 16 字节

这里与 webhook 当前实现的 `encodingAESKey` 模型不同。

## 4. 当前实现与长连接协议的主要差异

### 4.1 配置模型完全不同

当前 `wecom`：

- `token`
- `encodingAESKey`
- `receiveId`
- `webhookPath`

长连接需要：

- `botId`
- `secret`
- 可选 `wsUrl`
- 心跳/重连参数

这意味着 `config.ts`、`types.ts`、`openclaw.plugin.json` 都要扩展。

### 4.2 transport 生命周期完全不同

当前 `gateway.startAccount` 的行为是：

- 注册一个 webhook target
- 等待 `abortSignal`

长连接模式下需要：

- 建立 WebSocket
- 订阅鉴权
- 定时 ping
- 断线重连
- 维护连接状态

这已经不是“在现有函数里塞几行判断”能解决的事，必须有独立 transport 管理器。

### 4.3 回复路径完全不同

当前实现：

- 文本 / 媒体依赖活动 stream 内存态
- 模板卡片依赖 `response_url`

长连接实现：

- 文本 / 流式 / 欢迎语 / 卡片更新都要通过 WebSocket 主动发命令
- `response_url` 不再存在

所以 `channel.ts` 里直接依赖 `appendWecomActiveStreamChunk` 和 `consumeResponseUrl` 的逻辑必须抽象掉。

### 4.4 当前 `monitor.ts` 的 stream 状态是 webhook 特化的

当前 `monitor.ts` 的 stream 设计包含：

- HTTP 首次返回占位流
- 后续通过 webhook stream 刷新继续拉取内容
- `msgid -> streamId` 的 HTTP 轮询关系

这些不是长连接模式要的语义。  
长连接模式仍然需要“活动回复上下文”和“stream.id”，但不需要 HTTP 协商那一层。

### 4.5 媒体解密模型不兼容

当前 `bot.ts + crypto.ts` 默认认为：

- 只要有 `encodingAESKey` 就能解所有媒体

这在长连接模式下不成立。  
至少 `image` / `file` 必须改为按消息内 `aeskey` 解密。

### 4.6 当前主动发送能力不足

当前 `wecom` 的 `sendText` / `sendMedia` 在没有活动 stream 时会直接报错。  
这与长连接文档中 `aibot_send_msg` 的主动推送能力不一致。

不过从现有代码基础出发，主动推送不应该放在第一阶段实现，理由是：

- 需要会话激活状态管理
- 需要额度意识
- 当前插件已有很多“仅回复链路可用”的假设

## 5. 推荐总体方案

### 5.1 不复制插件目录

推荐方案：

- 保持插件 ID 仍然是 `wecom`
- 在同一插件内支持两种 transport mode
  - `webhook`
  - `ws`

不推荐新建 `extensions/wecom-ws`，原因：

- 用户语义会混乱
- 配置、路由、策略、媒体、会话逻辑会重复
- 后续修 bug 和补功能会双份维护

### 5.2 结构上先拆 transport，再接 ws

建议把当前代码按“公共业务层 / transport 层 / 状态层”拆开。

推荐分层如下：

- 公共业务层
  - `bot.ts` 中的消息路由、策略、OpenClaw 分发、session 更新
- transport 层
  - webhook transport
  - ws transport
- 回复状态层
  - 活动回复上下文
  - stream 绑定
  - 会话激活状态
- 工具层
  - 媒体解密
  - 临时文件服务
  - 协议类型

## 6. 推荐的目录与文件调整

为了减少一次性重写，建议采用“增量拆分”而不是彻底推翻。

### 6.1 保留的文件

- `extensions/wecom/index.ts`
- `extensions/wecom/src/channel.ts`
- `extensions/wecom/src/runtime.ts`

这几个文件继续作为插件入口和 ChannelPlugin 对外接口。

### 6.2 需要扩展的文件

- `extensions/wecom/src/types.ts`
- `extensions/wecom/src/config.ts`
- `extensions/wecom/openclaw.plugin.json`
- `extensions/wecom/package.json`

### 6.3 建议新增的文件

- `extensions/wecom/src/ws-gateway.ts`
- `extensions/wecom/src/ws-protocol.ts`
- `extensions/wecom/src/ws-state.ts`
- `extensions/wecom/src/reply-context.ts`
- `extensions/wecom/src/media.ts`

### 6.4 建议逐步瘦身的文件

- `extensions/wecom/src/monitor.ts`
- `extensions/wecom/src/bot.ts`
- `extensions/wecom/src/crypto.ts`
- `extensions/wecom/src/outbound-reply.ts`

建议拆分后的职责如下。

#### `src/ws-protocol.ts`

负责：

- WebSocket 入站 payload 类型定义
- `aibot_subscribe` / `ping` / `aibot_respond_*` / `aibot_send_msg` 的发送载荷组装
- `req_id` 生成
- 长连接回调消息转内部 `WecomInboundMessage` 的适配

#### `src/ws-gateway.ts`

负责：

- 建立 WebSocket 连接
- 订阅鉴权
- 心跳
- 重连
- 收到回调后转交 `dispatchWecomMessage`
- 接收 `disconnected_event` 后更新状态并做受控重连

这里建议参考 `extensions/qqbot/src/monitor.ts` 的连接管理方式，而不是把所有逻辑继续塞进 `monitor.ts`。

#### `src/ws-state.ts`

负责：

- 每个账号的活动连接
- 请求响应相关的 `req_id` 跟踪
- 最近一次连接状态
- 回调 `msgid` 去重
- 当前活动 stream 与 `sessionKey` / `runId` 的映射

#### `src/reply-context.ts`

这是整个改造最关键的公共层。

建议引入统一回复上下文：

```ts
type ActiveReplyContext = {
  accountId: string;
  to: string;
  transport: "webhook" | "ws";
  kind: "message" | "welcome" | "template_card_event";
  reqId?: string;
  responseUrl?: string;
  streamId?: string;
  sessionKey?: string;
  runId?: string;
  createdAt: number;
  expiresAt: number;
};
```

核心作用：

- 让 `channel.outbound.sendText/sendMedia/sendTemplateCard` 不再直接依赖某个 transport 的内部细节
- webhook 模式下仍然可以走旧的 stream / `response_url`
- ws 模式下则把 chunk 发送到当前 `req_id + stream.id`

当前的 `appendWecomActiveStreamChunk` 建议迁移或重命名为更通用的“活动回复追加”接口。

#### `src/media.ts`

建议把 `bot.ts` 中媒体下载和解密逻辑抽出来，支持：

- webhook 模式：`encodingAESKey`
- ws 模式：消息内 `aeskey`

并提供统一接口：

```ts
downloadAndDecryptMedia({
  mediaUrl,
  decryptionKey,
  keyKind: "encodingAESKey" | "messageAesKey"
})
```

这样 `bot.ts` 就不需要关心 transport 差异。

## 7. 配置设计建议

### 7.1 顶层思路

建议给 `channels.wecom` 增加 `mode`：

- `webhook`
- `ws`

默认值建议保持 `webhook`，以兼容现有用户。

### 7.2 建议配置形态

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "ws",
      "botId": "your-bot-id",
      "secret": "your-secret",
      "welcomeText": "你好，我是机器人",
      "dmPolicy": "pairing",
      "groupPolicy": "open"
    }
  }
}
```

多账号时：

```json
{
  "channels": {
    "wecom": {
      "defaultAccount": "main",
      "accounts": {
        "main": {
          "mode": "ws",
          "botId": "bot-main",
          "secret": "secret-main"
        },
        "legacy": {
          "mode": "webhook",
          "webhookPath": "/wecom-legacy",
          "token": "token",
          "encodingAESKey": "aes-key",
          "receiveId": "receive-id"
        }
      }
    }
  }
}
```

### 7.3 额外建议字段

建议新增但提供默认值：

- `wsUrl`
- `heartbeatIntervalMs`
- `reconnectInitialDelayMs`
- `reconnectMaxDelayMs`
- `replyStreamTtlMs`

### 7.4 环境变量建议

为了和当前 webhook 模式保持一致，默认账号可以支持环境变量回退：

- `WECOM_BOT_ID`
- `WECOM_SECRET`

## 8. 具体实现策略

### 8.1 `index.ts` 改造

当前 `index.ts` 总是注册 webhook 路径。  
改造后建议：

- 始终注册 `/wecom-media`
- 仅对 `mode=webhook` 的账号注册 `webhookPath`

这样 ws-only 部署不会暴露无意义的 `/wecom` 路径。

### 8.2 `gateway.startAccount` 改造

当前 `channel.ts` 的 `gateway.startAccount` 只支持 webhook。

改造后分支：

- `mode=webhook` -> 保持现状
- `mode=ws` -> 调用 `startWecomWsGateway`

状态输出建议补充：

- `mode`
- `running`
- `configured`
- `connectionState`
- `lastConnectAt`
- `lastSubscribeAt`
- `lastInboundAt`
- `lastOutboundAt`
- `lastPingAt`
- `lastDisconnectAt`
- `lastDisconnectReason`

### 8.3 入站消息处理复用 `dispatchWecomMessage`

推荐继续把 `dispatchWecomMessage` 作为公共业务入口。

需要补的只是：

- ws 回调转 `WecomInboundMessage`
- 在调用前注册活动回复上下文
- 在 `onChunk` 中把块内容发送到正确的 transport

换句话说：

- 入站 transport 不同
- OpenClaw 业务分发仍然共用

这是当前代码最值得保留的部分。

### 8.4 `sendText` / `sendMedia` 的改造方向

当前逻辑是：

- 找活动 stream
- 有则追加
- 没有就报错

建议改成：

1. 先查找当前活动回复上下文
2. 如果是 webhook message stream，保持现有行为
3. 如果是 ws message stream，发 `aibot_respond_msg`
4. 如果没有活动上下文，再判断是否允许主动推送
5. 若当前阶段尚未实现主动推送，则返回明确错误

也就是说，**第一阶段先让“已有消息触发的回复”跑通，不急着一开始就支持完全主动发送。**

### 8.5 `sendTemplateCard` 的改造方向

当前模板卡片依赖 `response_url`。  
在 ws 模式中应改为：

- 若当前上下文来自 `template_card_event`，发送 `aibot_respond_update_msg`
- 若后续支持主动推送，则在无活动事件上下文时可走 `aibot_send_msg`

建议第一阶段只实现：

- `template_card_event -> aibot_respond_update_msg`

这样复杂度更可控。

### 8.6 `welcomeText` 的改造方向

当前 webhook 模式是事件回调后在 HTTP 返回体中立即应答。  
ws 模式应改为：

- 收到 `enter_chat`
- 直接用事件里的 `req_id` 发送 `aibot_respond_welcome_msg`
- 尽量在 5 秒内完成

这部分可以不经过 agent，让行为和当前 webhook 自动欢迎语保持一致。

### 8.7 主动推送的实现策略

长连接文档虽然支持 `aibot_send_msg`，但建议放到第二阶段。

原因：

- 需要会话激活状态管理
- 需要区分 `userid` 与 `chatid`
- 需要考虑 24 小时回复额度与每日 10 条主动推送额度
- 当前 `wecom` 插件并没有成熟的“无活动上下文主动发消息”实现

建议第二阶段增加一个轻量的会话激活表，记录：

- accountId
- target
- lastInboundAt
- chatType
- activeForProactiveSend

第一阶段可以明确说明：

- ws 模式先支持消息回复、欢迎语、卡片更新
- 主动推送后补

### 8.8 媒体策略建议

当前 `wecom` 插件的媒体外发策略是：

- 把本地文件映射成 `/wecom-media/...`
- 再通过 Markdown 或文本链接回给用户

这个策略在长连接模式下仍然有价值，因为它不依赖企业微信原生上传接口。

建议保留这套临时文件服务，但需要注意：

- 当前基地址记录来自入站 HTTP 请求头
- ws 模式下没有天然 `Host` 请求上下文

所以需要新增一种基地址来源，建议顺序如下：

1. 配置项显式指定 `publicBaseUrl`
2. 沿用已有缓存
3. 若都没有，则禁用本地文件转公网链接并报明确错误

这是 ws 模式下一个容易被忽略的问题。

## 9. 推荐的实施阶段

### 阶段 0：先补测试，再做重构

当前 `extensions/wecom` 基本没有测试。  
建议先补最小测试框架，再进入长连接改造。

至少补：

- 配置解析
- target 解析
- webhook 现有基本行为
- stream 上下文追加

### 阶段 1：引入 mode 与 ws transport MVP

目标：

- 配置层支持 `mode=ws`
- 账号生命周期能启动 ws transport
- 收到 `aibot_msg_callback` 后能走 `dispatchWecomMessage`
- 回复可以通过 `aibot_respond_msg` 流式推送
- `welcomeText` 支持 `enter_chat`
- `template_card_event` 支持卡片更新

这一阶段不要追求主动发送全量功能。

### 阶段 2：抽离公共回复上下文

目标：

- 让 `channel.ts` 不再直接依赖 webhook 内部实现
- webhook / ws 共用一套活动回复上下文接口
- `monitor.ts` 和 `ws-gateway.ts` 只是 transport 实现

这是后续维护成本下降的关键步骤。

### 阶段 3：补主动推送与额度感知

目标：

- `aibot_send_msg`
- 已激活会话的主动 markdown / template_card
- 基础额度日志与错误提示

### 阶段 4：清理文档与兼容层

需要同步更新：

- `README.md`
- `doc/guides/wecom/configuration.md`
- `openclaw.plugin.json`

当前 README 里的能力表和 `wecom` 配置说明仍然完全是 callback 口径，届时要同步修正。

## 10. 测试建议

建议给 `extensions/wecom` 增加 `vitest`，覆盖以下内容。

### 10.1 单元测试

- `config.ts`
  - `mode` 默认值
  - webhook / ws 多账号解析
- `ws-protocol.ts`
  - 回调消息解析
  - 发送命令组装
- `reply-context.ts`
  - `sessionKey` / `runId` 绑定
  - stream 生命周期
- `media.ts`
  - `encodingAESKey` 模式解密
  - `aeskey` 模式解密

### 10.2 集成测试

- 模拟 WebSocket 服务端
- 连接后下发订阅成功响应
- 推送 `aibot_msg_callback`
- 断言插件会发送 `aibot_respond_msg`
- 推送 `enter_chat`
- 断言插件会发送 `aibot_respond_welcome_msg`
- 推送 `template_card_event`
- 断言插件会发送 `aibot_respond_update_msg`

### 10.3 回归测试

必须验证 webhook 现有行为不被破坏：

- GET 校验
- POST 解密
- 文本消息流式回复
- 模板卡片 `response_url`
- 多账号 webhook 路由

## 11. 风险与待确认点

### 11.1 `aibot_respond_msg` 的 markdown 支持边界

当前插件经常把图片/文件转换成 Markdown 链接塞进 stream 文本。  
长连接文档对 `stream.content` 的富文本能力没有写得足够细。

建议实现时做两手准备：

- 优先沿用当前 Markdown 链接策略
- 如果客户端渲染不稳定，则退化为纯 URL 文本

### 11.2 语音消息在长连接下的二进制细节

文档明确写了 `image` / `file` 额外返回 `aeskey`，但没有把 `voice` 的下载与解密规则讲清楚。  
当前实现不要强依赖“voice 一定能按现有 webhook 路径下载解密”，应优先使用已有文字转写内容。

### 11.3 多实例竞争连接

文档规定同一机器人同一时间只能有一条长连接。  
如果未来用户部署多实例，需要避免两个实例互相抢连接。

建议：

- 文档明确要求主备而非双活
- 代码里对频繁 `disconnected_event` 做退避

### 11.4 `publicBaseUrl` 缺失

ws 模式下没有 HTTP 请求头可供推断公网基地址。  
如果不补配置项，当前本地文件转外链能力会退化。

## 12. 最终建议

基于当前代码结构，最稳妥的实现路径是：

1. **继续在 `extensions/wecom` 内实现，不复制新插件目录**
2. **先引入 `mode=ws`，保留现有 webhook 兼容**
3. **先把 transport 与回复上下文拆开，再接入 WebSocket**
4. **第一阶段只做“消息回复 + 欢迎语 + 卡片更新”**
5. **主动推送、额度感知、外链基地址增强放第二阶段**

一句话概括：

当前 `wecom` 已经有一条可复用的“OpenClaw 分发管道”，真正需要重做的是**传输层和回复上下文层**。  
只要先把这两层从 `monitor.ts` 里拆出来，长连接模式可以在现有基础上平滑接入，而不需要重建一个新插件。
