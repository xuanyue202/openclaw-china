# 企业微信（智能机器人）渠道配置指南

<div align="center">

  <p>
    <strong>⭐ 如果这个项目对你有帮助，请给我们一个Star！⭐</strong><br>
    <em>您的支持是我们持续改进的动力</em>
  </p>
</div>

本文档用于配置 OpenClaw China 的企业微信智能机器人渠道（`wecom`）。

仓库地址：<https://github.com/BytePioneer-AI/openclaw-china>


## 一、在企业微信后台创建智能机器人

### 1. 注册并登录企业微信

访问 <https://work.weixin.qq.com/>，按页面提示注册并进入管理后台。

![企业注册-1](../../images/wecom_register_company_step1.png)
![企业注册-2](../../images/wecom_register_company_step2.png)
![企业注册-3](../../images/wecom_register_company_step3.png)
![企业注册-4](../../images/wecom_register_company_step4.png)

### 2. 创建智能机器人并选择 API 模式

![创建机器人-1](../../images/wecom_create_bot_step1.png)
![创建机器人-2](../../images/wecom_create_bot_step2.png)

![创建机器人-3](D:\work\code\moltbot-china\doc\images\image-20260308222851633.png)

![image-20260308223411308](D:\work\code\moltbot-china\doc\images\image-20260308223411308.png)

企业微信智能机器人现在有两种接入方式：

- `webhook`：企业微信回调你的 HTTP 地址，**需要公网可访问的回调地址**。
- 【**推荐，**企业微信于**3月8日**发布此方式，本插件于**当天**率先支持】`ws`：长连接方式，**不需要固定公网 IP**。

长连接与短连接（Webhook）方式对比

| 特性       | Webhook（短连接）    | WebSocket（长连接）              |
| ---------- | -------------------- | -------------------------------- |
| 连接方式   | 每次回调建立新连接   | 复用已建立的长连接               |
| 延迟       | 较高（每次需建连）   | 低（复用连接）                   |
| 实时性     | 一般                 | 好                               |
| 服务端要求 | 需要公网可访问的 URL | 无需固定的公网 IP                |
| 加解密     | 需要对消息加解密     | 无需加解密                       |
| 复杂度     | 低                   | 较高（需维护心跳）               |
| 可靠性     | 高（无状态）         | 需要心跳保活、断线重连           |
| 适用场景   | 普通回调场景         | 高实时性要求、无固定公网 IP 场景 |

#### 长连接方式（无需公网 IP）

**推荐，**企业微信于**3月8日**发布此方式，本插件于**当天**率先支持

![image-20260308222753962](D:\work\code\moltbot-china\doc\images\image-20260308222753962.png)



#### 短连接方式（需公网 IP）

![回调参数位置](../../images/wecom_bot_token_and_aeskey.png)



### 3. 机器人二维码

![image-20260308223801195](D:\work\code\moltbot-china\doc\images\image-20260308223801195.png)



## 二、安装 OpenClaw 与插件

### 1. 安装 OpenClaw

```bash
npm install -g openclaw@latest
```

### 2. 初始化网关

```bash
openclaw onboard --install-daemon
```

按向导完成基础初始化即可，渠道配置后面再补。

### 3. 安装渠道插件

**方式一：安装聚合包（推荐）**

```bash
openclaw plugins install @openclaw-china/channels
openclaw china setup
```
仅安装企业微信渠道

```bash
openclaw plugins install @openclaw-china/wecom
```

**方式二：从源码安装，全平台通用**

⚠️ Windows 用户注意：由于 OpenClaw 存在 Windows 兼容性问题（spawn npm ENOENT），npm 安装方式暂不可用，请使用方式二。

```bash
git clone https://github.com/BytePioneer-AI/openclaw-china.git
cd openclaw-china
pnpm install
pnpm build
openclaw plugins install -l ./packages/channels
openclaw china setup
```


## 三、配置

插件支持 `webhook` 和 `ws` 两种模式。未填写 `mode` 时，默认仍按 `webhook` 处理。

最小可用配置如下。

### 1. `webhook` 模式

> 推荐使用「配置向导」：`openclaw china setup`

```bash
openclaw config set channels.wecom.enabled true
openclaw config set channels.wecom.mode webhook
openclaw config set channels.wecom.webhookPath /wecom
openclaw config set channels.wecom.token your-token
openclaw config set channels.wecom.encodingAESKey your-43-char-encoding-aes-key
openclaw config set gateway.bind lan
```

也可以直接编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "webhook",
      "webhookPath": "/wecom",
      "token": "your-token",
      "encodingAESKey": "your-43-char-encoding-aes-key"
    }
  }
}
```

### 2. `ws` 长连接模式

适合没有固定公网 IP、只能主动访问外网的部署环境。

```bash
openclaw config set channels.wecom.enabled true
openclaw config set channels.wecom.mode ws
openclaw config set channels.wecom.botId your-bot-id
openclaw config set channels.wecom.secret your-secret
openclaw config set channels.wecom.publicBaseUrl https://bot.example.com
```

也可以直接编辑配置：

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "ws",
      "botId": "your-bot-id",
      "secret": "your-secret",
      "publicBaseUrl": "https://bot.example.com"
    }
  }
}
```

可选项：

- `wsUrl`: 默认 `wss://openws.work.weixin.qq.com`
- `heartbeatIntervalMs`: 心跳间隔，默认 30000
- `reconnectInitialDelayMs`: 首次重连延迟，默认 1000
- `reconnectMaxDelayMs`: 最大重连延迟，默认 30000
- `publicBaseUrl`: `ws` 模式发送本地图片/文件时必填，用于暴露 `/wecom-media/...` 临时地址

可选策略项（按需）：

- `dmPolicy`: `open | pairing | allowlist | disabled`
- `allowFrom`: 私聊白名单
- `groupPolicy`: `open | allowlist | disabled`
- `groupAllowFrom`: 群聊白名单
- `requireMention`: 群聊是否要求 @ 机器人

### 3. 当前行为说明

- `webhook` 模式保持原有回调行为。
- `ws` 模式下，收到企业微信长连接回调后，会在同一条 WebSocket 上回消息。
- `ws` 模式支持当前进程内“已激活会话”的主动发送：
  用户或群先给机器人发过至少一条消息后，后续可以主动发 `markdown` 或 `template_card`。
- 如果 `ws` 模式下从未收到该用户/群的消息，主动发送会直接返回明确错误，不会静默丢弃。
- `ws` 模式发送本地媒体文件时，必须先配置 `publicBaseUrl`，否则无法生成企业微信可访问的临时链接。

## 四、启动并验证

调试启动（推荐先用）：

```bash
openclaw gateway --port 18789 --verbose
```

或后台启动：

```bash
openclaw daemon start
```


## 五、创建机器人

**点击 创建**

![创建机器人确认](../../images/wecom_bot_create_confirm.png)

创建完毕后扫码添加机器人，即可开启聊天。

![扫码添加机器人](../../images/wecom_bot_qr_add.png)
