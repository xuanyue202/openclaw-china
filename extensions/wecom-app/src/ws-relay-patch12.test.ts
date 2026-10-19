/**
 * PATCH12 unit tests: relay send_result interpretation.
 * (Ported from the production hotfix on the OpenClaw host, 2026-09-08.)
 */
import { describe, it, expect, vi } from "vitest";
import { buildWsRelaySendOutcome } from "./ws-relay-client.js";

const base = { type: "send_result" as const, id: "send_1" };

describe("PATCH12 buildWsRelaySendOutcome", () => {
  it("ok=true without errcode → accepted with correlated transportAck, no fake platform id", () => {
    const r = buildWsRelaySendOutcome({ ...base, ok: true });
    expect(r).toEqual({
      ok: true, errcode: undefined, errmsg: undefined, msgid: undefined,
      transportAck: { kind: "wecom-relay-send-result", requestId: "send_1", accepted: true },
    });
  });

  it("ok=true, errcode=0 → accepted", () => {
    expect(buildWsRelaySendOutcome({ ...base, ok: true, errcode: 0, errmsg: "ok" }).ok).toBe(true);
  });

  it("ok=true but non-zero errcode → NOT accepted, no transportAck", () => {
    const r = buildWsRelaySendOutcome({ ...base, ok: true, errcode: 81013, errmsg: "user invalid" });
    expect(r.ok).toBe(false);
    expect(r.transportAck).toBeUndefined();
    expect(r.errcode).toBe(81013);
  });

  it("ok=false → NOT accepted", () => {
    const r = buildWsRelaySendOutcome({ ...base, ok: false, errcode: -1, errmsg: "boom" });
    expect(r).toMatchObject({ ok: false, errcode: -1, errmsg: "boom", transportAck: undefined });
  });

  it("truthy non-boolean ok is NOT treated as accepted", () => {
    const r = buildWsRelaySendOutcome({ ...base, ok: "true" as unknown as boolean });
    expect(r.ok).toBe(false);
  });

  it("platform id passes through from msgid / message_id / messageId", () => {
    expect(buildWsRelaySendOutcome({ ...base, ok: true, msgid: "a" }).msgid).toBe("a");
    expect(buildWsRelaySendOutcome({ ...base, ok: true, message_id: "b" }).msgid).toBe("b");
    expect(buildWsRelaySendOutcome({ ...base, ok: true, messageId: "c" }).msgid).toBe("c");
  });

  it("logs acceptance without leaking the id value", () => {
    const info = vi.fn();
    buildWsRelaySendOutcome({ ...base, ok: true, msgid: "secret-ish-id" }, { info });
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]![0] as string;
    expect(line).toContain("requestId=send_1 accepted=true platformId=present errcode=absent");
    expect(line).not.toContain("secret-ish-id");
  });
});
