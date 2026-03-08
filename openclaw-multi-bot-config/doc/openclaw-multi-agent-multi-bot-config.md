# OpenClaw 多 Agent / 多机器人配置指南

本文严格基于 OpenClaw 官方参考文档整理，目标是说明以下 4 个配置块如何配合工作：

- `agents.defaults` / `agents.list`
- `channels.<channel>.accounts`
- `bindings`
- `session.dmScope`

适用场景：

- 一个 Gateway 进程承载多个独立机器人
- 一个渠道挂多个账号/机器人
- 想区分“只是会话隔离”与“真正多 Agent 隔离”

本文中的配置示例统一使用钉钉场景：

- 渠道：`dingtalk`
- 账号：`main`、`work`
- Agent：`ding-main`、`ding-work`

## 1. 官方核心概念

### 1.1 Agent 是什么

官方定义中，一个 `agent` 是一个完整隔离的“脑”：

- 独立 workspace
- 独立 `agentDir`
- 独立 session store
- 独立 auth profiles

这意味着：

- 不同 `agentId` 天然是不同工作区、不同人格、不同记忆
- 如果多个机器人都进同一个 `agentId`，那它们本质上还是同一个 Agent，只是入口不同

### 1.2 AccountId 是什么

`accountId` 是渠道内的一个账号实例。

例如：

- 一个钉钉机器人应用 = 一个 `accountId`
- 一个 Telegram bot = 一个 `accountId`
- 一个多账号渠道中的一个登录实例 = 一个 `accountId`

官方推荐的多账号配置形态是：

```json
{
  "channels": {
    "dingtalk": {
      "defaultAccount": "main",
      "accounts": {
        "main": {
          "clientId": "your-main-client-id",
          "clientSecret": "your-main-client-secret"
        },
        "work": {
          "clientId": "your-work-client-id",
          "clientSecret": "your-work-client-secret"
        }
      }
    }
  }
}
```

### 1.3 Binding 是什么

`binding` 用来把入站消息路由到某个 `agentId`。

最常见的匹配维度：

- `match.channel`
- `match.accountId`
- `match.peer`
- `match.guildId`
- `match.teamId`

如果没有 `bindings`，消息会走默认 Agent。

### 1.4 dmScope 是什么

`session.dmScope` 只控制私聊会话如何分桶，不决定消息去哪个 Agent。

官方定义：

- `main`: 所有私聊共用主会话
- `per-peer`: 按发送者隔离
- `per-channel-peer`: 按渠道 + 发送者隔离
- `per-account-channel-peer`: 按账号 + 渠道 + 发送者隔离

官方明确建议：

- 多用户收件箱：`per-channel-peer`
- 多账号收件箱：`per-account-channel-peer`

注意：

- `dmScope` 只影响 direct message
- group / channel chat 本来就按会话独立

## 2. 四个配置块分别解决什么问题

### 2.1 `agents.list`

解决“有几个独立 Agent”。

示例：

```json
{
  "agents": {
    "defaults": {
      "workspace": "C:\\Users\\Administrator\\.openclaw\\workspace"
    },
    "list": [
      {
        "id": "ding-main",
        "default": true,
        "workspace": "C:\\Users\\Administrator\\.openclaw\\workspace-ding-main"
      },
      {
        "id": "ding-work",
        "workspace": "C:\\Users\\Administrator\\.openclaw\\workspace-ding-work"
      }
    ]
  }
}
```

含义：

- `ding-main` 和 `ding-work` 是两个真正独立的 Agent
- 每个 Agent 都有自己的 workspace、session、auth

### 2.2 `channels.<channel>.accounts`

解决“这个渠道有几个机器人/账号”。

示例：

```json
{
  "channels": {
    "dingtalk": {
      "defaultAccount": "main",
      "enabled": true,
      "enableAICard": false,
      "accounts": {
        "main": {
          "clientId": "your-main-client-id",
          "clientSecret": "your-main-client-secret"
        },
        "work": {
          "clientId": "your-work-client-id",
          "clientSecret": "your-work-client-secret"
        }
      }
    }
  }
}
```

含义：

- 这是一个渠道的多账号配置
- 还没有决定这些账号分别路由到哪个 Agent

### 2.3 `bindings`

解决“哪个账号 / 哪条会话 进哪个 Agent”。

示例：

```json
{
  "bindings": [
    {
      "agentId": "ding-main",
      "match": {
        "channel": "dingtalk",
        "accountId": "main"
      }
    },
    {
      "agentId": "ding-work",
      "match": {
        "channel": "dingtalk",
        "accountId": "work"
      }
    }
  ]
}
```

含义：

- `main` 账号进 `ding-main`
- `work` 账号进 `ding-work`

这是“多机器人真正独立”的关键配置。

### 2.4 `session.dmScope`

解决“私聊历史会不会串”。

官方推荐的多账号写法：

```json
{
  "session": {
    "dmScope": "per-account-channel-peer"
  }
}
```

含义：

- 同一个渠道下，不同账号、不同发送者会落到不同 DM session key
- 它解决的是“会话隔离”
- 它不等于“多 Agent 隔离”

## 3. 官方推荐的两种常见模式

### 3.1 模式 A：多机器人，共用一个 Agent

适合：

- 想让多个机器人共用同一个人格/工作区
- 只要求消息历史不要串

配置重点：

- 配 `channels.<channel>.accounts`
- 配 `session.dmScope: "per-account-channel-peer"`
- 不强制要求 `bindings`

效果：

- 多个钉钉账号仍可能进入同一个默认 Agent
- 但私聊历史会分开

示例：

```json
{
  "session": {
    "dmScope": "per-account-channel-peer"
  },
  "channels": {
    "dingtalk": {
      "defaultAccount": "main",
      "enabled": true,
      "enableAICard": false,
      "accounts": {
        "main": {
          "clientId": "your-main-client-id",
          "clientSecret": "your-main-client-secret"
        },
        "work": {
          "clientId": "your-work-client-id",
          "clientSecret": "your-work-client-secret"
        }
      }
    }
  }
}
```

### 3.2 模式 B：多机器人，多 Agent 完全隔离

适合：

- 不同机器人就是不同角色
- 每个机器人都要自己的 workspace / 记忆 / auth
- 想要真正的“独立机器人”

配置重点：

- 配 `agents.list`
- 配 `channels.<channel>.accounts`
- 配 `bindings.match.accountId`
- DM 再配 `session.dmScope: "per-account-channel-peer"`

示例：

```json
{
  "agents": {
    "list": [
      {
        "id": "ding-main",
        "default": true,
        "workspace": "C:\\Users\\Administrator\\.openclaw\\workspace-ding-main"
      },
      {
        "id": "ding-work",
        "workspace": "C:\\Users\\Administrator\\.openclaw\\workspace-ding-work"
      }
    ]
  },
  "session": {
    "dmScope": "per-account-channel-peer"
  },
  "bindings": [
    {
      "agentId": "ding-main",
      "match": {
        "channel": "dingtalk",
        "accountId": "main"
      }
    },
    {
      "agentId": "ding-work",
      "match": {
        "channel": "dingtalk",
        "accountId": "work"
      }
    }
  ],
  "channels": {
    "dingtalk": {
      "defaultAccount": "main",
      "enabled": true,
      "enableAICard": false,
      "accounts": {
        "main": {
          "clientId": "your-main-client-id",
          "clientSecret": "your-main-client-secret"
        },
        "work": {
          "clientId": "your-work-client-id",
          "clientSecret": "your-work-client-secret"
        }
      }
    }
  }
}
```

效果：

- `main` 和 `work` 是两个不同钉钉账号
- 分别进入不同 Agent
- workspace、sessions、auth 都独立

## 4. 官方路由规则

OpenClaw 为每条入站消息只选择一个 Agent。

官方匹配顺序：

1. `match.peer`
2. `match.parentPeer`
3. `match.guildId + roles`
4. `match.guildId`
5. `match.teamId`
6. `match.accountId`
7. `match.accountId: "*"`
8. 默认 Agent

补充规则：

- 同一层级内，第一个匹配项生效
- 一个 binding 里写了多个 match 字段时，按 AND 逻辑同时满足
- 省略 `accountId` 时，只匹配默认账号
- `accountId: "*"` 表示该渠道任意账号都可匹配

## 5. 默认账号规则

在多账号渠道里，官方建议显式设置：

```json
{
  "channels": {
    "dingtalk": {
      "defaultAccount": "main"
    }
  }
}
```

如果不设：

- 优先用 `accounts.default`
- 否则回落到排序后的第一个账号 id

因此，两个及以上账号时，建议总是显式写 `defaultAccount`。

## 6. 会话隔离与 Agent 隔离的区别

这是官方配置里最容易混淆的部分：

### 6.1 只配 `dmScope`

结果：

- 解决 DM 会话串线
- 不保证不同机器人进入不同 Agent
- 多个账号仍可能共用同一个 workspace

### 6.2 再配 `bindings + agents.list`

结果：

- 解决“谁来回复”
- 解决“用哪个 workspace / auth / session store”
- 才是完整的多机器人隔离方案

最短结论：

- `dmScope` 解决会话隔离
- `bindings + 多 Agent` 解决机器人隔离

## 7. 官方建议的检查命令

配置完成后，官方文档建议至少执行：

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

如果涉及 DM 隔离与安全，还建议：

```bash
openclaw security audit
```

## 8. 一个可复用的钉钉模板

下面这份模板适合“钉钉多账号 + 多 Agent 独立机器人”：

```json
{
  "agents": {
    "defaults": {
      "workspace": "C:\\Users\\Administrator\\.openclaw\\workspace"
    },
    "list": [
      {
        "id": "ding-main",
        "default": true,
        "workspace": "C:\\Users\\Administrator\\.openclaw\\workspace-ding-main"
      },
      {
        "id": "ding-work",
        "workspace": "C:\\Users\\Administrator\\.openclaw\\workspace-ding-work"
      }
    ]
  },
  "session": {
    "dmScope": "per-account-channel-peer"
  },
  "bindings": [
    {
      "agentId": "ding-main",
      "match": {
        "channel": "dingtalk",
        "accountId": "main"
      }
    },
    {
      "agentId": "ding-work",
      "match": {
        "channel": "dingtalk",
        "accountId": "work"
      }
    }
  ],
  "channels": {
    "dingtalk": {
      "defaultAccount": "main",
      "enabled": true,
      "enableAICard": false,
      "accounts": {
        "main": {
          "clientId": "your-main-client-id",
          "clientSecret": "your-main-client-secret"
        },
        "work": {
          "clientId": "your-work-client-id",
          "clientSecret": "your-work-client-secret"
        }
      }
    }
  }
}
```

将其中：

- `your-main-client-id` / `your-main-client-secret` 替换成主账号凭证
- `your-work-client-id` / `your-work-client-secret` 替换成工作账号凭证
- `ding-main` / `ding-work` 可以按你的 agent 命名习惯调整

## 9. 适用到你的项目时怎么理解

如果某个渠道插件支持：

- `channels.<channel>.accounts.<accountId>`
- `channels.<channel>.defaultAccount`
- 入站把 `accountId` 传给 OpenClaw 路由

那么它就可以按本指南工作。钉钉插件当前就属于这种接法。

最终是否只是“会话分开”，还是“机器人彻底独立”，取决于你是否同时配置了：

- `session.dmScope`
- `agents.list`
- `bindings`

## 10. 官方文档来源

- `doc/reference-projects/openclaw/docs/concepts/multi-agent.md`
- `doc/reference-projects/openclaw/docs/concepts/session.md`
- `doc/reference-projects/openclaw/docs/gateway/configuration-reference.md`
- `doc/reference-projects/openclaw/docs/channels/channel-routing.md`
- `doc/reference-projects/openclaw/docs/tools/plugin.md`
