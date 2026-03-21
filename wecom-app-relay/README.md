# wecom-app-relay

企业微信自建应用 WebSocket 中继服务器。

将企微回调通过 WebSocket 转发给 OpenClaw extension 客户端，客户端的回复通过中继调用企微 API 发送。**extension 端无需公网 IP**。

## 架构

```
企微用户 → 企微服务器 → [HTTP 回调] → wecom-app-relay (公网服务器)
                                           ↕ [WebSocket]
                                      OpenClaw extension (可在内网)
                                           ↕
                                      wecom-app-relay → [企微 API] → 企微用户
```

## 快速开始

### 1. 安装

```bash
# npm 全局安装
npm install -g @xuanyue202/wecom-app-relay

# 或 npx 直接运行
npx @xuanyue202/wecom-app-relay --config relay.config.json

# 或从源码运行
cd wecom-app-relay
pnpm install
pnpm dev -- --config relay.config.json
```

### 2. 创建配置文件

创建 `relay.config.json`：

```json
{
  "host": "0.0.0.0",
  "port": 9080,
  "authToken": "你的认证密钥-随机生成一个长字符串",
  "accounts": {
    "default": {
      "token": "企微回调Token",
      "encodingAESKey": "企微回调EncodingAESKey（43位）",
      "receiveId": "企业ID",
      "corpId": "企业ID",
      "corpSecret": "应用Secret",
      "agentId": 1000002,
      "webhookPath": "/wecom"
    }
  }
}
```

> **`authToken`** 是 extension 客户端连接中继时的认证密钥，请使用随机字符串，与企微的 token 无关。

### 3. 启动中继

```bash
wecom-app-relay --config relay.config.json
```

输出：

```
[relay] listening on 0.0.0.0:9080
[relay] WebSocket endpoint: ws://0.0.0.0:9080/ws
[relay] Webhook endpoint:   http://0.0.0.0:9080/webhook
[relay] WeCom callback [default]: http://0.0.0.0:9080/wecom
```

### 4. 配置企微后台

在企微管理后台 → 应用管理 → 你的自建应用 → API 接收消息：

- **URL**：`http://你的服务器IP:9080/wecom`
- **Token**：与配置文件中 `accounts.default.token` 一致
- **EncodingAESKey**：与配置文件中 `accounts.default.encodingAESKey` 一致

在「企业可信 IP」中添加中继服务器的公网 IP。

### 5. 配置 OpenClaw extension

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "wecom-app": {
      "enabled": true,
      "mode": "ws-relay",
      "token": "企微回调Token",
      "encodingAESKey": "企微回调EncodingAESKey",
      "corpId": "企业ID",
      "corpSecret": "应用Secret",
      "agentId": 1000002,
      "wsRelayUrl": "ws://你的中继服务器IP:9080/ws",
      "wsRelayWebhookUrl": "http://你的中继服务器IP:9080/webhook"
    }
  }
}
```

## 配置参考

### 配置文件字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `host` | string | `0.0.0.0` | 监听地址 |
| `port` | number | `9080` | 监听端口 |
| `authToken` | string | 必填 | WebSocket 认证密钥 |
| `accounts` | object | 必填 | 企微账户配置（支持多账户） |

### 账户字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | string | 企微回调 Token |
| `encodingAESKey` | string | 企微回调加密密钥（43 位） |
| `receiveId` | string | 接收者 ID（通常等于 corpId） |
| `corpId` | string | 企业 ID |
| `corpSecret` | string | 应用 Secret |
| `agentId` | number | 应用 AgentId |
| `apiBaseUrl` | string | 企微 API 地址（默认 `https://qyapi.weixin.qq.com`） |
| `webhookPath` | string | 企微回调路径（默认 `/wecom`） |

### 环境变量

也可以通过环境变量配置（无配置文件时使用）：

| 环境变量 | 对应字段 |
|----------|---------|
| `RELAY_AUTH_TOKEN` | `authToken` |
| `RELAY_HOST` | `host` |
| `RELAY_PORT` | `port` |
| `WECOM_CORP_ID` | `accounts.default.corpId` + `receiveId` |
| `WECOM_CORP_SECRET` | `accounts.default.corpSecret` |
| `WECOM_AGENT_ID` | `accounts.default.agentId` |
| `WECOM_TOKEN` | `accounts.default.token` |
| `WECOM_AES_KEY` | `accounts.default.encodingAESKey` |
| `WECOM_WEBHOOK_PATH` | `accounts.default.webhookPath` |

## HTTP 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/{webhookPath}` | 企微回调（GET 验证 URL，POST 接收消息） |
| POST | `/webhook` | 接收客户端响应，代调企微 API 发送 |
| GET | `/health` | 健康检查，返回连接状态 |

## 安全特性

- **认证密钥**：WebSocket 连接需提供 `authToken`（constant-time 比较，防时序攻击）
- **认证超时**：连接后 10 秒未认证自动断开
- **心跳检测**：每 30 秒 ping，90 秒无响应断开
- **速率限制**：每分钟最多 120 条消息
- **请求体限制**：HTTP/WebSocket 消息最大 1MB
- **Session 校验**：webhook 响应必须携带有效 session_id
- **后连接顶替**：同一账户新连接自动断开旧连接
- **企微签名验证**：回调请求经过签名校验，防伪造

## 多账户配置

支持同时代理多个企微自建应用：

```json
{
  "authToken": "shared-auth-token",
  "accounts": {
    "app1": {
      "token": "token-1",
      "encodingAESKey": "key-1",
      "receiveId": "ww_corp_1",
      "corpId": "ww_corp_1",
      "corpSecret": "secret-1",
      "agentId": 1000002,
      "webhookPath": "/wecom/app1"
    },
    "app2": {
      "token": "token-2",
      "encodingAESKey": "key-2",
      "receiveId": "ww_corp_2",
      "corpId": "ww_corp_2",
      "corpSecret": "secret-2",
      "agentId": 1000003,
      "webhookPath": "/wecom/app2"
    }
  }
}
```

## 协议兼容性

兼容 [lsbot](https://github.com/ruilisi/lsbot) relay 协议。extension 客户端也可以连接 `bot.lingti.com` 公共中继服务（注意共享 IP 和凭证信任问题）。

## 反向代理与 HTTPS

### 有域名（推荐）

用 Caddy 自动签发 Let's Encrypt 证书：

```
your.domain.com {
    reverse_proxy localhost:9080
}
```

extension 配置：
```json
{
  "wsRelayUrl": "wss://your.domain.com/ws",
  "wsRelayWebhookUrl": "https://your.domain.com/webhook"
}
```

### 无域名（纯 IP + 自签证书）

用 Caddy 自签证书，加密传输但不防中间人：

```
:443 {
    tls internal
    reverse_proxy localhost:9080
}
```

extension 配置需加 `wsRelayInsecure: true`：
```json
{
  "wsRelayUrl": "wss://123.45.67.89/ws",
  "wsRelayWebhookUrl": "https://123.45.67.89/webhook",
  "wsRelayInsecure": true
}
```

> **安全说明**：自签证书场景下，传输通道已加密，但无法验证服务器身份。wecom_raw 模式下对话内容本身仍由企微 AES-256-CBC 加密，中间人只能看到密文。

### Nginx 方案

```nginx
server {
    listen 443 ssl;
    server_name your.domain.com;  # 或 _（纯 IP）

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:9080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }
}
```

> `proxy_read_timeout` 设大值避免 WebSocket 长连接被 nginx 超时断开。

## 部署建议

- 可使用 systemd 或 pm2 管理进程
- 日志输出到 stdout/stderr，可接入日志收集系统
