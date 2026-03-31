import { describe, expect, it } from "vitest";
import { splitTextChunks } from "./channel.js";

describe("splitTextChunks", () => {
  it("returns single chunk for short text", () => {
    expect(splitTextChunks("hello", 500)).toEqual(["hello"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitTextChunks("", 500)).toEqual([]);
  });

  it("returns original text when exactly at limit", () => {
    const text = "a".repeat(500);
    expect(splitTextChunks(text, 500)).toEqual([text]);
  });

  it("splits on paragraph boundaries", () => {
    const p1 = "a".repeat(300);
    const p2 = "b".repeat(300);
    const text = `${p1}\n\n${p2}`;
    const chunks = splitTextChunks(text, 500);
    expect(chunks).toEqual([p1, p2]);
  });

  it("splits on line boundaries when paragraph is too long", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}: ${"x".repeat(80)}`);
    const text = lines.join("\n");
    const chunks = splitTextChunks(text, 200);
    // Each chunk should be <= 200 chars
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    // Reassembled text should be the same
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-cuts single very long line", () => {
    const text = "x".repeat(1200);
    const chunks = splitTextChunks(text, 500);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe("x".repeat(500));
    expect(chunks[1]).toBe("x".repeat(500));
    expect(chunks[2]).toBe("x".repeat(200));
  });

  it("preserves paragraph boundaries across multiple paragraphs", () => {
    const text = "short\n\nmedium text here\n\nanother paragraph";
    const chunks = splitTextChunks(text, 500);
    expect(chunks).toEqual([text]);
  });

  it("handles mixed short and long paragraphs", () => {
    const short = "hello";
    const long = "x".repeat(600);
    const text = `${short}\n\n${long}`;
    const chunks = splitTextChunks(text, 500);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe(short);
    expect(chunks[1]).toBe("x".repeat(500));
    expect(chunks[2]).toBe("x".repeat(100));
  });

  it("merges small paragraphs into a single chunk", () => {
    const text = "para 1\n\npara 2\n\npara 3";
    const chunks = splitTextChunks(text, 500);
    expect(chunks).toEqual([text]);
  });

  it("splits correctly when two paragraphs exceed limit together", () => {
    const p1 = "a".repeat(300);
    const p2 = "b".repeat(300);
    const p3 = "c".repeat(300);
    const text = `${p1}\n\n${p2}\n\n${p3}`;
    const chunks = splitTextChunks(text, 500);
    // p1 (300) + \n\n + p2 (300) = 604 > 500, so must split
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it("handles text with only newlines", () => {
    const text = "\n\n\n\n";
    const chunks = splitTextChunks(text, 500);
    // All whitespace, should return empty or single chunk
    expect(chunks.length).toBeLessThanOrEqual(1);
  });

  it("does not lose content during splitting", () => {
    const text = "Hello world!\n\nThis is a test.\n\nAnother paragraph here.\n\n" + "x".repeat(600);
    const chunks = splitTextChunks(text, 500);
    // Verify no content is lost (join with paragraph separators and compare content chars)
    const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
    // Allow for separator chars difference
    expect(totalChars).toBeGreaterThanOrEqual(text.replace(/\n\n/g, "").length);
  });

  it("respects limit of 1 (edge case)", () => {
    const chunks = splitTextChunks("abc", 1);
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("returns original for non-positive limit (no chunking)", () => {
    // Non-positive limit means "no splitting" — return text as-is
    expect(splitTextChunks("abc", 0)).toEqual(["abc"]);
    expect(splitTextChunks("abc", -1)).toEqual(["abc"]);
  });
});
