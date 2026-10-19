/**
 * Relay server 配置
 */
import { z } from "zod";
import { readFileSync } from "node:fs";

const AccountSchema = z.object({
  token: z.string(),
  encodingAESKey: z.string(),
  receiveId: z.string().default(""),
  corpId: z.string(),
  corpSecret: z.string(),
  agentId: z.number(),
  apiBaseUrl: z.string().default("https://qyapi.weixin.qq.com"),
  webhookPath: z.string().default("/wecom"),
  /**
   * Per-account shared secret used by WS clients to sign their auth message
   * (HMAC-SHA256, see auth.ts). Optional during migration; required for this
   * account once `authMode` is "strict". Also accepted as a Bearer token on
   * POST /send, scoped to this account only.
   */
  clientSecret: z.string().min(32, "clientSecret must be at least 32 characters").optional(),
});

const ConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().default(9080),
  authToken: z.string(),
  accounts: z.record(AccountSchema),
  /**
   * "compat" (default): accounts without clientSecret, and unsigned clients of accounts
   *   that do have one, are still accepted (logged + auth_result.warnings). A *wrong*
   *   signature is always rejected.
   * "strict": every corpId+agentId login must carry a valid per-account signature;
   *   accounts without clientSecret cannot be logged into via corpId+agentId.
   */
  authMode: z.enum(["compat", "strict"]).optional(),
  /** Allowed clock skew for auth_ts, seconds (default 300). */
  authMaxSkewSec: z.number().int().positive().optional(),
  /** Allow WS login with the global authToken (grants ALL accounts). Default true. */
  allowGlobalTokenWs: z.boolean().optional(),
  /** Allow POST /send with the global authToken (any account). Default true. */
  allowGlobalTokenSend: z.boolean().optional(),
});

export type AccountConfig = z.infer<typeof AccountSchema>;
export type RelayConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): RelayConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return ConfigSchema.parse(raw);
}

export function loadConfigFromEnv(): RelayConfig | null {
  const token = process.env.RELAY_AUTH_TOKEN;
  const corpId = process.env.WECOM_CORP_ID;
  const corpSecret = process.env.WECOM_CORP_SECRET;
  const agentId = process.env.WECOM_AGENT_ID;
  const wecomToken = process.env.WECOM_TOKEN;
  const aesKey = process.env.WECOM_AES_KEY;

  if (!token || !corpId || !corpSecret || !agentId || !wecomToken || !aesKey) return null;

  const clientSecret = process.env.WECOM_RELAY_CLIENT_SECRET || undefined;
  const authMode = process.env.RELAY_AUTH_MODE;
  if (authMode && authMode !== "compat" && authMode !== "strict") {
    throw new Error(`RELAY_AUTH_MODE must be "compat" or "strict"`);
  }
  if (clientSecret && clientSecret.length < 32) {
    throw new Error("WECOM_RELAY_CLIENT_SECRET must be at least 32 characters");
  }
  const parseBool = (v: string | undefined): boolean | undefined =>
    v === undefined ? undefined : !["0", "false", "no", "off"].includes(v.toLowerCase());

  return {
    host: process.env.RELAY_HOST ?? "0.0.0.0",
    port: parseInt(process.env.RELAY_PORT ?? "9080", 10),
    authToken: token,
    authMode: authMode as "compat" | "strict" | undefined,
    authMaxSkewSec: process.env.RELAY_AUTH_MAX_SKEW_SEC ? parseInt(process.env.RELAY_AUTH_MAX_SKEW_SEC, 10) : undefined,
    allowGlobalTokenWs: parseBool(process.env.RELAY_ALLOW_GLOBAL_TOKEN_WS),
    allowGlobalTokenSend: parseBool(process.env.RELAY_ALLOW_GLOBAL_TOKEN_SEND),
    accounts: {
      default: {
        token: wecomToken,
        encodingAESKey: aesKey,
        receiveId: corpId,
        corpId,
        corpSecret,
        agentId: parseInt(agentId, 10),
        apiBaseUrl: process.env.WECOM_API_BASE_URL ?? "https://qyapi.weixin.qq.com",
        webhookPath: process.env.WECOM_WEBHOOK_PATH ?? "/wecom",
        clientSecret,
      },
    },
  };
}
