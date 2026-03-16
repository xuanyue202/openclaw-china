# OpenClaw 渠道插件实现 Checklist

## 1. 用途

这份文档只保留“以后继续开发新渠道插件时需要核对的事项”，不再重复展开 OpenClaw 插件体系原理。

如果需要看背景和架构细节，优先参考：

- `doc/design/openclaw-china-new-channel-plugin-preparation.md`
- `doc/design/openclaw-channel-plugin-architecture.md`

## 2. 开发前先定的规则

- 新渠道先做成独立插件：`extensions/<channel-id>/`
- 再接入聚合包：`packages/channels`
- 渠道配置放在 `channels.<channel-id>`
- 多账号放在 `channels.<channel-id>.accounts.<accountId>`
- 除非有明确理由，否则保持：
  - 插件 id = 渠道 id = package 元数据里的 channel id

## 3. 插件目录最低要求

```text
extensions/<channel-id>/
├── package.json
├── openclaw.plugin.json
├── index.ts
└── src/
    ├── channel.ts
    ├── config.ts
    ├── runtime.ts
    ├── send.ts
    ├── probe.ts
    └── types.ts
```

如果渠道有明显入站逻辑，通常还需要：

```text
src/
├── webhook.ts / monitor.ts
├── inbound.ts / bot.ts
├── onboarding.ts
└── state.ts
```

## 4. 静态文件 Checklist

### 4.1 `openclaw.plugin.json`

必须有：

- `id`
- `channels: ["<channel-id>"]`
- `configSchema`

注意：

- 即使插件级配置为空，也保留一个空 `configSchema`
- 这个 schema 校验的是 `plugins.entries.<pluginId>.config`
- 它不是 `channels.<channel-id>` 的 schema

最小示例：

```json
{
  "id": "demochat",
  "channels": ["demochat"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

### 4.2 `package.json`

至少确认：

- `name`
- `type: "module"`
- `main` / `types` / `exports`
- `openclaw.extensions`
- `moltbot.extensions`
- `clawdbot.extensions`

如果是渠道插件，还建议声明：

- `openclaw.channel`
- `moltbot.channel`
- `clawdbot.channel`
- `install.npmSpec`

## 5. 入口文件 Checklist

`index.ts` 只做接入，不堆业务逻辑。

至少确认：

- 默认导出插件入口对象
- `register(api)` 中调用 `api.registerChannel({ plugin })`
- 需要时注册 `china setup` CLI
- 需要时显示安装提示
- 需要时保存 runtime 桥接
- 需要 HTTP 入站时注册 webhook handler / route

最关键的一步始终是：

```ts
api.registerChannel({ plugin });
```

## 6. `ChannelPlugin` 最小实现 Checklist

最少应有：

- `id`
- `meta`
- `capabilities`
- `configSchema`
- `config`
- `outbound`

建议首版就补上：

- `gateway`
- `status`
- `onboarding`

按价值排序，通常优先级是：

1. `outbound.sendText`
2. `gateway.startAccount`
3. `status.probeAccount`
4. `onboarding.configure`

## 7. `config` 适配器 Checklist

至少确认：

- `listAccountIds`
- `resolveAccount`
- `defaultAccountId`
- `isConfigured`

推荐一起实现：

- `describeAccount`
- `setAccountEnabled`
- `deleteAccount`

统一约定：

- 默认账号常量：`DEFAULT_ACCOUNT_ID = "default"`
- 顶层配置与 `accounts.<accountId>` 合并解析
- 默认账号支持环境变量兜底时，只在默认账号上生效

## 8. 入站渠道 Checklist

如果这个渠道需要接收消息，优先实现 `gateway.startAccount/stopAccount`。

至少确认：

- `startAccount` 能注册 webhook / ws / poller
- `stopAccount` 能释放资源
- 正确响应 `abortSignal`
- 更新账号运行状态
- 账号级别而不是进程级别启动

如果是 webhook / 长轮询 / 拉取型渠道，通常还要有：

- 路由注册
- 验签 / 鉴权
- 解包 / 解密
- cursor / offset / seq 持久化
- 去重
- 错误状态写回

## 9. Reply 管线 Checklist

如果渠道接入统一 reply dispatcher，至少确认：

- 处理 `empty`
- 处理 `silent`
- 处理 `heartbeat`
- 不发送不可见 payload
- 对平台发送限制做缓冲、合并或分片

不要默认把 reply block 原样逐条推送给平台。

## 10. Runtime 桥接 Checklist

插件只声明自己实际需要的 runtime 子集，不直接耦合宿主内部路径。

常见依赖：

- `channel.routing`
- `channel.reply`
- `channel.session`
- `channel.text`

推荐模式：

- `setXxxRuntime(next)`
- `getXxxRuntime()`
- `tryGetXxxRuntime()`
- `clearXxxRuntime()`

## 11. 聚合包接入 Checklist

单插件完成后，再改 `packages/channels`。

至少同步这些地方：

### 11.1 `packages/channels/package.json`

- 增加子插件依赖

### 11.2 `packages/channels/openclaw.plugin.json`

- 在 `channels` 列表里增加新的 channel id

### 11.3 `packages/channels/src/index.ts`

- 导入默认入口
- 导入命名导出
- 重新导出 plugin / 类型 / runtime helper
- 加入 `SUPPORTED_CHANNELS`
- 加入 `channelPlugins`
- 扩展统一配置类型

结论：

- 聚合包是“注册聚合器”
- 不是第二套渠道实现

## 12. 文档与 CLI Checklist

至少补这些：

- `extensions/<channel-id>/README.md`
- `doc/guides/<channel-id>/README.md`
- `china setup` 交互式配置
- install hint

文档至少写清：

- 需要哪些参数
- 参数从哪里拿
- 后台前置条件
- 回调要求
- 首版能力边界
- 已知平台限制

## 13. 验证 Checklist

至少验证：

- 单插件可构建
- 单插件可测试
- 聚合包可构建
- `china setup` 可写入配置
- 插件能被宿主识别并注册
- 最小消息闭环可跑通

最小闭环标准：

1. 平台消息能进来
2. 能路由到 Agent
3. Agent 回复能发回去

## 14. 常见错误

- 把渠道配置写进 `plugins.entries.<id>.config`
- 缺少 `openclaw.plugin.json`
- manifest 没写 `channels`
- `index.ts` 忘了 `api.registerChannel({ plugin })`
- `package.json` 和运行时 id 不一致
- 只做单插件，不接 `packages/channels`
- `startAccount` 注册了资源，但 `stopAccount` 不释放
- 忽略 `empty` / `silent` / `heartbeat`
- 直接复用旧渠道对象模型，没按新平台语义重建 target / session / account 模型

## 15. 交付前最后核对

- 插件可以单独安装
- 插件可以通过聚合包安装
- 配置路径是 `channels.<id>`
- 多账号路径是 `channels.<id>.accounts.<accountId>`
- `outbound.sendText` 已稳定
- 入站渠道的 `gateway.startAccount` 已稳定
- `status` 和 `onboarding` 至少有基础实现
- README 已写清安装、配置、联调
