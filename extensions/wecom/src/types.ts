export type WecomDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
export type WecomGroupPolicy = "open" | "allowlist" | "disabled";
export type WecomTransportMode = "webhook" | "ws";
export type WecomWsImageReplyMode = "native" | "markdown-url";

export type WecomRetryConfig = {
  /** 最大重试次数，默认 3 */
  attempts?: number;
  /** 最小退避延迟(ms)，默认 400 */
  minDelayMs?: number;
  /** 最大退避延迟(ms)，封顶，默认 30000 */
  maxDelayMs?: number;
  /** 随机抖动比例（0-1），防多实例同时重试，默认 0.1 */
  jitter?: number;
};

export type WecomAccountConfig = {
  name?: string;
  enabled?: boolean;
  mode?: WecomTransportMode;

  webhookPath?: string;
  token?: string;
  encodingAESKey?: string;
  receiveId?: string;
  botId?: string;
  secret?: string;
  wsUrl?: string;
  heartbeatIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  publicBaseUrl?: string;
  wsImageReplyMode?: WecomWsImageReplyMode;

  welcomeText?: string;

  dmPolicy?: WecomDmPolicy;
  allowFrom?: string[];

  groupPolicy?: WecomGroupPolicy;
  groupAllowFrom?: string[];
  requireMention?: boolean;

  retry?: WecomRetryConfig;
};

export type WecomConfig = WecomAccountConfig & {
  accounts?: Record<string, WecomAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedWecomAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  mode: WecomTransportMode;
  token?: string;
  encodingAESKey?: string;
  receiveId: string;
  botId?: string;
  secret?: string;
  wsUrl: string;
  heartbeatIntervalMs: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  publicBaseUrl?: string;
  wsImageReplyMode: WecomWsImageReplyMode;
  retry: Required<WecomRetryConfig>;
  config: WecomAccountConfig;
};

export type WecomInboundBase = {
  msgid?: string;
  aibotid?: string;
  chattype?: "single" | "group";
  chatid?: string;
  response_url?: string;
  from?: { userid?: string; corpid?: string };
  msgtype?: string;
};

export type WecomInboundText = WecomInboundBase & {
  msgtype: "text";
  text?: { content?: string };
  quote?: unknown;
};

export type WecomInboundVoice = WecomInboundBase & {
  msgtype: "voice";
  voice?: { content?: string };
  quote?: unknown;
};

export type WecomInboundStreamRefresh = WecomInboundBase & {
  msgtype: "stream";
  stream?: { id?: string };
};

export type WecomInboundEvent = WecomInboundBase & {
  msgtype: "event";
  create_time?: number;
  event?: {
    eventtype?: string;
    [key: string]: unknown;
  };
};

export type WecomInboundMessage =
  | WecomInboundText
  | WecomInboundVoice
  | WecomInboundStreamRefresh
  | WecomInboundEvent
  | (WecomInboundBase & Record<string, unknown>);
