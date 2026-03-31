import { describe, expect, it, vi } from "vitest";
import {
  calculateRetryDelay,
  DEFAULT_RETRY_CONFIG,
  isRetryableWecomError,
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

describe("isRetryableWecomError", () => {
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

  it("does not retry on generic errors without status", () => {
    expect(isRetryableWecomError(new Error("unknown error"))).toBe(false);
    expect(isRetryableWecomError("string error")).toBe(false);
    expect(isRetryableWecomError(null)).toBe(false);
  });
});

describe("withWecomRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withWecomRetry("test", fn, { attempts: 3 });
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
      attempts: 3,
      minDelayMs: 1,
      maxDelayMs: 10,
      jitter: 0,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on non-retryable error", async () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withWecomRetry("test", fn, { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 }),
    ).rejects.toThrow("forbidden");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all attempts", async () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withWecomRetry("test", fn, { attempts: 2, minDelayMs: 1, maxDelayMs: 10, jitter: 0 }),
    ).rejects.toThrow("server error");
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("works with zero attempts (no retry)", async () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withWecomRetry("test", fn, { attempts: 0 }),
    ).rejects.toThrow("server error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses default config when none provided", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withWecomRetry("test", fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
