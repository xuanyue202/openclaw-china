/**
 * 企业微信 HTTP 请求级重试机制
 *
 * 设计参考飞书 Channel Retry，Per-request 重试：
 * - 指数退避 + jitter + cap
 * - delay = min(minDelayMs × 2^attempt, maxDelayMs) × (1 ± jitter)
 *
 * 可重试错误：
 * - WeCom API errcode: -1(系统繁忙)、45009(频率限制)、45033(并发限制)
 * - HTTP 429 Rate Limit（优先取 API 返回的 retry_after）
 * - 超时 / 连接重置 / socket 关闭
 * - 5xx 服务端错误
 *
 * 不重试（永久错误）：
 * - 401/403 鉴权失败
 * - 参数错误（4xx 非 429）
 * - 其他 WeCom errcode（权限、参数等）
 * - AbortError（主动取消）
 */

import type { WecomRetryConfig } from "./types.js";

/** 默认重试配置 */
export const DEFAULT_RETRY_CONFIG: Required<WecomRetryConfig> = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30000,
  jitter: 0.1,
};

/**
 * WeCom API 错误，携带 errcode 以便重试逻辑识别
 *
 * 参考飞书 FeishuBackoffError 的设计：将 API 层面的错误码
 * 结构化地暴露出来，而不是埋在 message 字符串里。
 */
export class WecomApiError extends Error {
  readonly errcode: number;
  readonly errmsg: string;

  constructor(errcode: number, errmsg: string, prefix?: string) {
    const msg = prefix
      ? `${prefix}: ${errcode} ${errmsg}`.trim()
      : `WeCom API error: ${errcode} ${errmsg}`.trim();
    super(msg);
    this.name = "WecomApiError";
    this.errcode = errcode;
    this.errmsg = errmsg;
  }
}

/**
 * WeCom 可重试的 errcode 集合
 *
 * 对标飞书的 FEISHU_BACKOFF_CODES (99991400, 99991403, 429)
 */
const WECOM_RETRYABLE_ERRCODES = new Set([
  -1,     // 系统繁忙，服务端内部错误，稍后再试
  45009,  // 接口调用超过频率限制
  45033,  // 接口并发调用超过限制
]);

/**
 * 计算退避延迟（指数退避 + jitter + cap）
 *
 * delay = min(minDelayMs × 2^attempt, maxDelayMs) × (1 ± jitter)
 */
export function calculateRetryDelay(
  attempt: number,
  config: Required<WecomRetryConfig>,
): number {
  const base = Math.min(
    config.minDelayMs * Math.pow(2, attempt),
    config.maxDelayMs,
  );
  const jitterRange = base * config.jitter;
  const jitterOffset = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(base + jitterOffset));
}

/** 从错误中提取 HTTP 状态码 */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  return undefined;
}

/** 从错误中提取 WeCom API errcode */
function extractErrcode(error: unknown): number | undefined {
  if (error instanceof WecomApiError) return error.errcode;
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.errcode === "number") return candidate.errcode;
  return undefined;
}

/** 从错误中提取 retry-after 秒数（429 场景） */
function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.retryAfter === "number" && candidate.retryAfter > 0) {
    return candidate.retryAfter * 1000;
  }
  if (typeof candidate.retryAfter === "string") {
    const secs = parseFloat(candidate.retryAfter);
    if (!isNaN(secs) && secs > 0) return secs * 1000;
  }
  return undefined;
}

/** 判断是否为主动取消（不应重试） */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}

/** 判断是否为网络 / 连接类错误 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // AbortError 是主动取消，不是网络错误
  if (isAbortError(error)) return false;
  const name = error.name.toLowerCase();
  const msg = error.message.toLowerCase();
  return (
    name === "typeerror" ||
    name === "timeouterror" ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up") ||
    msg.includes("socket closed") ||
    msg.includes("timeout") ||
    msg.includes("connection reset") ||
    msg.includes("temporarily unavailable")
  );
}

/** 判断错误是否可重试 */
export function isRetryableWecomError(error: unknown): boolean {
  // 主动取消 → 绝不重试
  if (isAbortError(error)) return false;

  // 网络/超时/连接类错误 → 重试
  if (isNetworkError(error)) return true;

  // WeCom API errcode → 只有特定错误码可重试
  const errcode = extractErrcode(error);
  if (errcode !== undefined) {
    return WECOM_RETRYABLE_ERRCODES.has(errcode);
  }

  // HTTP 状态码
  const status = extractStatusCode(error);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  return false;
}

/**
 * Abort-aware sleep，参考飞书的 waitForAbortableDelay
 *
 * @returns true 如果延迟正常结束，false 如果被 abort
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    // 不阻止 Node 进程退出
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** withWecomRetry 的选项 */
export interface WecomRetryOptions {
  config?: WecomRetryConfig;
  /** 可选的 AbortSignal，shutdown 时取消重试 */
  signal?: AbortSignal;
  /** 日志函数，默认 console.log */
  log?: (msg: string) => void;
}

/**
 * 带重试的 WeCom API 调用执行器
 *
 * @param label 操作标签，用于日志
 * @param fn 要执行的异步函数
 * @param opts 重试选项（config、signal、log）
 * @returns 函数执行结果
 */
export async function withWecomRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: WecomRetryConfig | WecomRetryOptions,
): Promise<T> {
  // 兼容旧调用方式：直接传 WecomRetryConfig
  const isOptions = opts != null && ("config" in opts || "signal" in opts || "log" in opts);
  const options: WecomRetryOptions = isOptions ? (opts as WecomRetryOptions) : { config: opts as WecomRetryConfig | undefined };

  const resolved: Required<WecomRetryConfig> = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.config,
  };
  const log = options.log ?? console.log;
  const signal = options.signal;

  let lastError: unknown;

  for (let attempt = 0; attempt <= resolved.attempts; attempt++) {
    // 检查 abort
    if (signal?.aborted) {
      throw lastError ?? new Error("WeCom retry aborted");
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 最后一次尝试，不再重试
      if (attempt >= resolved.attempts) {
        throw error;
      }

      // 不可重试的错误，直接抛出
      if (!isRetryableWecomError(error)) {
        throw error;
      }

      // 计算延迟：429 优先使用 retry_after
      const retryAfterMs = extractRetryAfterMs(error);
      const delay = retryAfterMs ?? calculateRetryDelay(attempt, resolved);

      log(
        `[wecom] ${label} attempt ${attempt + 1}/${resolved.attempts + 1} failed, retrying in ${delay}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      // Abort-aware 延迟
      const elapsed = await abortableSleep(delay, signal);
      if (!elapsed) {
        // 被 abort 了，抛出最后一个错误
        throw error;
      }
    }
  }

  // 理论上不会到达这里
  throw lastError;
}
