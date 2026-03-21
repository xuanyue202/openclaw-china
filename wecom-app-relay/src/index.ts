/**
 * wecom-app-relay — 企业微信自建应用 WebSocket 中继服务
 *
 * 用法:
 *   wecom-app-relay --config relay.config.json
 *   wecom-app-relay (使用环境变量)
 *
 * 兼容 lsbot relay 协议。
 */

import { loadConfig, loadConfigFromEnv, type RelayConfig } from "./config.js";
import { createRelayServer } from "./server.js";

function printUsage() {
  console.log(`
wecom-app-relay — 企业微信自建应用 WebSocket 中继服务

用法:
  wecom-app-relay --config <path>    使用 JSON 配置文件
  wecom-app-relay                    使用环境变量

环境变量:
  RELAY_AUTH_TOKEN    认证 Token（必填）
  RELAY_HOST          监听地址（默认 0.0.0.0）
  RELAY_PORT          监听端口（默认 9080）
  WECOM_CORP_ID       企业 ID
  WECOM_CORP_SECRET   应用 Secret
  WECOM_AGENT_ID      应用 AgentId
  WECOM_TOKEN         回调 Token
  WECOM_AES_KEY       回调 EncodingAESKey
  WECOM_WEBHOOK_PATH  回调路径（默认 /wecom）

配置文件示例:
  {
    "host": "0.0.0.0",
    "port": 9080,
    "authToken": "your-secret-token",
    "accounts": {
      "default": {
        "token": "wecom-callback-token",
        "encodingAESKey": "43-char-key",
        "receiveId": "ww...",
        "corpId": "ww...",
        "corpSecret": "...",
        "agentId": 1000002,
        "webhookPath": "/wecom"
      }
    }
  }
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let config: RelayConfig;

  const configIdx = args.indexOf("--config");
  if (configIdx >= 0 && args[configIdx + 1]) {
    try {
      config = loadConfig(args[configIdx + 1]!);
      console.log(`[relay] loaded config from ${args[configIdx + 1]}`);
    } catch (err) {
      console.error(`Failed to load config: ${String(err)}`);
      process.exit(1);
    }
  } else {
    const envConfig = loadConfigFromEnv();
    if (!envConfig) {
      console.error("No config file and missing required env vars.");
      printUsage();
      process.exit(1);
    }
    config = envConfig;
    console.log("[relay] using environment variables");
  }

  const relay = createRelayServer(config);
  await relay.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[relay] shutting down...");
    await relay.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
