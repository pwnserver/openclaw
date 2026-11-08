import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebhookContext } from "../types.js";
import { AsteriskProvider } from "./asterisk.js";

const SECRET = "test-secret";

function signedContext(payload: Record<string, unknown>, secret = SECRET): WebhookContext {
  const rawBody = JSON.stringify(payload);
  return {
    headers: {
      "x-signature": crypto.createHmac("sha256", secret).update(rawBody).digest("hex"),
    },
    rawBody,
    url: "http://localhost/voice/webhook",
    method: "POST",
    query: {},
  };
}

function createProvider() {
  return new AsteriskProvider({ url: "http://mediaserver:9081/", secret: SECRET });
}

let seq = 0;
function uniqueTimestamp() {
  seq += 1;
  return 1_700_000_000_000 + seq;
}

describe("AsteriskProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a valid HMAC signature and flags a repeated delivery as replay", () => {
    const provider = createProvider();
    const ctx = signedContext({
      event: "call.ended",
      callId: "ws-1",
      timestamp: uniqueTimestamp(),
    });

    const first = provider.verifyWebhook(ctx);
    expect(first.ok).toBe(true);
    expect(first.isReplay).toBe(false);
    expect(first.verifiedRequestKey).toMatch(/^asterisk:/);

    const second = provider.verifyWebhook(ctx);
    expect(second.ok).toBe(true);
    expect(second.isReplay).toBe(true);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
  });

  it("rejects missing or wrong signatures", () => {
    const provider = createProvider();
    const payload = { event: "call.ended", callId: "ws-2", timestamp: uniqueTimestamp() };

    const unsigned = { ...signedContext(payload), headers: {} };
    expect(provider.verifyWebhook(unsigned)).toMatchObject({ ok: false });

    expect(provider.verifyWebhook(signedContext(payload, "other-secret"))).toMatchObject({
      ok: false,
      reason: "Invalid HMAC signature",
    });
  });

  it("normalizes mediaserver events", () => {
    const provider = createProvider();
    const ts = uniqueTimestamp();

    const initiated = provider.parseWebhookEvent(
      signedContext({
        event: "call.initiated",
        callId: "ws-3",
        timestamp: ts,
        data: { from: "+79990000000", to: "goip-1", direction: "sideways" },
      }),
    );
    expect(initiated.events).toEqual([
      expect.objectContaining({
        type: "call.initiated",
        callId: "ws-3",
        providerCallId: "ws-3",
        direction: "inbound",
        from: "+79990000000",
        id: `ast-ws-3-call.initiated-${ts}`,
        dedupeKey: `ast-ws-3-call.initiated-${ts}`,
      }),
    ]);

    const speech = provider.parseWebhookEvent(
      signedContext({
        event: "call.speech",
        callId: "ws-3",
        timestamp: ts,
        data: { transcript: "Merhaba" },
      }),
    );
    expect(speech.events).toEqual([
      expect.objectContaining({ type: "call.speech", transcript: "Merhaba", isFinal: true }),
    ]);
    // Same millisecond, different event type: ids must not collide.
    expect(speech.events[0]?.id).not.toBe(initiated.events[0]?.id);

    const endReason = (reason: unknown) =>
      provider.parseWebhookEvent(
        signedContext({
          event: "call.ended",
          callId: "ws-4",
          timestamp: uniqueTimestamp(),
          data: { reason },
        }),
      ).events[0];
    // The mediaserver sends "hangup"; call records reject unknown reasons.
    expect(endReason("hangup")).toEqual(
      expect.objectContaining({ type: "call.ended", reason: "completed" }),
    );
    expect(endReason(undefined)).toEqual(expect.objectContaining({ reason: "completed" }));
    expect(endReason("hangup-user")).toEqual(expect.objectContaining({ reason: "hangup-user" }));

    expect(
      provider.parseWebhookEvent(signedContext({ event: "call.unknown", callId: "ws-3" })).events,
    ).toEqual([]);
    expect(
      provider.parseWebhookEvent({ ...signedContext({}), rawBody: "{not json" }).statusCode,
    ).toBe(400);
  });

  it("maps getCallStatus for active, gone and unreachable sessions", async () => {
    const provider = createProvider();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "active", is_terminal: false })),
    );
    await expect(provider.getCallStatus({ providerCallId: "ws-4" })).resolves.toEqual({
      status: "active",
      isTerminal: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://mediaserver:9081/api/call/ws-4/status");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "not_found", is_terminal: true })),
    );
    await expect(provider.getCallStatus({ providerCallId: "ws-4" })).resolves.toEqual({
      status: "not_found",
      isTerminal: true,
    });

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(provider.getCallStatus({ providerCallId: "ws-4" })).resolves.toEqual({
      status: "unknown",
      isTerminal: false,
      isUnknown: true,
    });
  });

  it("sends speak requests to the mediaserver API", async () => {
    const provider = createProvider();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", fetchMock);

    await provider.playTts({ callId: "c-1", providerCallId: "ws-5", text: "Минуточку" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://mediaserver:9081/api/call/speak",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ session_id: "ws-5", text: "Минуточку" }),
      }),
    );
  });
});
