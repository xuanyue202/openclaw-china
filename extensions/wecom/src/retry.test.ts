import { describe, expect, it, vi } from "vitest";
import {
  calculateRetryDelay,
  DEFAULT_RETRY_CONFIG,
  isRetryableWecomError,
  WecomApiError,
  withWecomRetry,
} from "./retry.js";

describe("calculateRetryDelay", () => {
  it("returns minDelayMs for attempt 0", () => {
    const delay = calculateRetryDelay(0, { ...DEFAULT_RETRY_CONFIG, jitter: 0 });
    expect(delay).toBe(400);
  });

  it("doubles delay for each attempt", () => {
    const config = { ...DEFAULT_RETRY_CONFIG, jitter: 0 };
    expect(calculateRetryDelay(0, config)).toBe(400);
    expect(calculateRetryDelay(1, config)).toBe(800);
    expect(calculateRetryDelay(2, config)).toBe(1600);
    expect(calculateRetryDelay(3, config)).toBe(3200);
  });

  it("caps at maxDelayMs", () => {
    const config = { ...DEFAULT_RETRY_CONFIG, jitter: 0, maxDelayMs: 2000 };
    expect(calculateRetryDelay(0, config)).toBe(400);
    expect(calculateRetryDelay(1, config)).toBe(800);
    expect(calculateRetryDelay(2, config)).toBe(1600);
    expect(calculateRetryDelay(3, config)).toBe(2000);
    expect(calculateRetryDelay(10, config)).toBe(2000);
  });

  it("applies jitter within expected range", () => {
    const config = { ...DEFAULT_RETRY_CONFIG, jitter: 0.1 };
    const samples = Array.from({ length: 100 }, () => calculateRetryDelay(0, config));
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    // 400 * (1 - 0.1) = 360, 400 * (1 + 0.1) = 440
    expect(min).toBeGreaterThanOrEqual(360);
    expect(max).toBeLessThanOrEqual(440);
  });
});

describe("WecomApiError", () => {
  it("carries errcode and errmsg", () => {
    const err = new WecomApiError(45009, "api freq over limit");
    expect(err.errcode).toBe(45009);
    expect(err.errmsg).toBe("api freq over limit");
    expect(err.name).toBe("WecomApiError");
    expect(err.message).toContain("45009");
  });

  it("includes prefix in message", () => {
    const err = new WecomApiError(45009, "api freq over limit", "proactive send failed");
    expect(err.message).toBe("proactive send failed: 45009 api freq over limit");
  });
});

describe("isRetryableWecomError", () => {
  // --- HTTP status codes ---
  it("retries on 429", () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    expect(isRetryableWecomError(err)).toBe(true);
  });

  it("retries on 500", () => {
    const err = Object.assign(new Error("internal error"), { status: 500 });
    expect(isRetryableWecomError(err)).toBe(true);
  });

  it("retries on 502", () => {
    const err = Object.assign(new Error("bad gateway"), { status: 502 });
    expect(isRetryableWecomError(err)).toBe(true);
  });

  it("retries on 503", () => {
    const err = Object.assign(new Error("service unavailable"), { status: 503 });
    expect(isRetryableWecomError(err)).toBe(true);
  });

  it("does not retry on 401", () => {
    const err = Object.assign(new Error("unauthorized"), { status: 401 });
    expect(isRetryableWecomError(err)).toBe(false);
  });

  it("does not retry on 403", () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    expect(isRetryableWecomError(err)).toBe(false);
  });

  it("does not retry on 400", () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    expect(isRetryableWecomError(err)).toBe(false);
  });

  // --- WeCom API errcode (via WecomApiError) ---
  it("retries on WecomApiError with errcode -1 (system busy)", () => {
    expect(isRetryableWecomError(new WecomApiError(-1, "system busy"))).toBe(true);
  });

  it("retries on WecomApiError with errcode 45009 (rate limit)", () => {
    expect(isRetryableWecomError(new WecomApiError(45009, "api freq over limit"))).toBe(true);
  });

  it("retries on WecomApiError with errcode 45033 (concurrency limit)", () => {
    expect(isRetryableWecomError(new WecomApiError(45033, "api concurrency over limit"))).toBe(true);
  });

  it("does not retry on WecomApiError with other errcodes", () => {
    expect(isRetryableWecomError(new WecomApiError(40014, "invalid access_token"))).toBe(false);
    expect(isRetryableWecomError(new WecomApiError(60011, "no permission"))).toBe(false);
    expect(isRetryableWecomError(new WecomApiError(41001, "access_token missing"))).toBe(false);
  });

  // --- Network errors ---
  it("retries on network/timeout errors", () => {
    const timeout = new Error("timeout");
    timeout.name = "TimeoutError";
    expect(isRetryableWecomError(timeout)).toBe(true);

    const typeError = new TypeError("fetch failed");
    expect(isRetryableWecomError(typeError)).toBe(true);

    expect(isRetryableWecomError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableWecomError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableWecomError(new Error("connection reset by peer"))).toBe(true);
  });

  // --- AbortError ---
  it("does not retry on AbortError", () => {
    const err = new Error("operation aborted");
    err.name = "AbortError";
    expect(isRetryableWecomError(err)).toBe(false);
  });

  // --- Generic errors ---
  it("does not retry on generic errors without status", () => {
    expect(isRetryableWecomError(new Error("unknown error"))).toBe(false);
    expect(isRetryableWecomError("string error")).toBe(false);
    expect(isRetryableWecomError(null)).toBe(false);
  });
});

describe("withWecomRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withWecomRetry("test", fn, { config: { attempts: 3 } });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue("recovered");

    const result = await withWecomRetry("test", fn, {
      config: { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 },
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on WecomApiError with retryable errcode", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new WecomApiError(45009, "freq limit"))
      .mockResolvedValue("recovered");

    const result = await withWecomRetry("test", fn, {
      config: { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 },
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry WecomApiError with non-retryable errcode", async () => {
    const fn = vi.fn().mockRejectedValue(new WecomApiError(40014, "invalid token"));

    await expect(
      withWecomRetry("test", fn, { config: { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 } }),
    ).rejects.toThrow("invalid token");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on non-retryable error", async () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withWecomRetry("test", fn, { config: { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 } }),
    ).rejects.toThrow("forbidden");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all attempts", async () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withWecomRetry("test", fn, { config: { attempts: 2, minDelayMs: 1, maxDelayMs: 10, jitter: 0 } }),
    ).rejects.toThrow("server error");
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("works with zero attempts (no retry)", async () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withWecomRetry("test", fn, { config: { attempts: 0 } }),
    ).rejects.toThrow("server error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses default config when none provided", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withWecomRetry("test", fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("accepts bare WecomRetryConfig for backward compat", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withWecomRetry("test", fn, { attempts: 1, minDelayMs: 1, maxDelayMs: 10, jitter: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    const err = Object.assign(new Error("server error"), { status: 500 });
    let attempt = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 2) controller.abort();
      return Promise.reject(err);
    });

    await expect(
      withWecomRetry("test", fn, {
        config: { attempts: 5, minDelayMs: 1, maxDelayMs: 10, jitter: 0 },
        signal: controller.signal,
      }),
    ).rejects.toThrow("server error");
    // Should stop after abort, not exhaust all 5 attempts
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("does not retry on AbortError", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withWecomRetry("test", fn, { config: { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 } }),
    ).rejects.toThrow("aborted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses custom log function", async () => {
    const log = vi.fn();
    const err = Object.assign(new Error("server error"), { status: 500 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    await withWecomRetry("test", fn, {
      config: { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 },
      log,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("[wecom] test attempt");
  });
});
