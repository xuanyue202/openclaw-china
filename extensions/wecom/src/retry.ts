/**
 * 企业微信 HTTP 请求级重试机制
 *
 * 设计参考飞书 Channel Retry，Per-request 重试：
 * - 指数退避 + jitter + cap
 * - delay = min(minDelayMs × 2^attempt, maxDelayMs) × (1 ± jitter)
 *
 * 可重试错误：
 * - 429 Rate Limit（优先取 API 返回的 retry_after）
 * - 超时 / 连接重置 / socket 关闭
 * - 5xx 服务端错误
 * - 临时不可用
 *
 * 不重试（永久错误）：
 * - 401/403 鉴权失败
 * - 参数错误（4xx 非 429）
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
  // WeCom SDK wraps errcode in response
  if (typeof candidate.errcode === "number") {
    // errcode is not an HTTP status; don't treat it as one
    return undefined;
  }
  return undefined;
}

/** 从错误中提取 retry-after 秒数（429 场景） */
function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  // Some HTTP libraries attach headers or retryAfter
  if (typeof candidate.retryAfter === "number" && candidate.retryAfter > 0) {
    return candidate.retryAfter * 1000;
  }
  if (typeof candidate.retryAfter === "string") {
    const secs = parseFloat(candidate.retryAfter);
    if (!isNaN(secs) && secs > 0) return secs * 1000;
  }
  return undefined;
}

/** 判断是否为网络 / 连接类错误 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name.toLowerCase();
  const msg = error.message.toLowerCase();
  return (
    name === "typeerror" ||
    name === "timeouterror" ||
    name === "aborterror" ||
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
  // 网络/超时/连接类错误 → 重试
  if (isNetworkError(error)) return true;

  const status = extractStatusCode(error);
  if (status !== undefined) {
    // 429 Rate Limit → 重试
    if (status === 429) return true;
    // 5xx 服务端错误 → 重试
    if (status >= 500 && status < 600) return true;
    // 其他 4xx（401/403/400 等）→ 不重试
    if (status >= 400 && status < 500) return false;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的 WeCom API 调用执行器
 *
 * @param label 操作标签，用于日志
 * @param fn 要执行的异步函数
 * @param config 重试配置
 * @returns 函数执行结果
 */
export async function withWecomRetry<T>(
  label: string,
  fn: () => Promise<T>,
  config?: WecomRetryConfig,
): Promise<T> {
  const resolved: Required<WecomRetryConfig> = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= resolved.attempts; attempt++) {
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

      console.log(
        `[wecom] ${label} attempt ${attempt + 1}/${resolved.attempts + 1} failed, retrying in ${delay}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      await sleep(delay);
    }
  }

  // 理论上不会到达这里
  throw lastError;
}
