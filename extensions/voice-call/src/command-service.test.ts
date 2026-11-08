import { describe, expect, it, vi } from "vitest";
import { createVoiceCallCommandService } from "./command-service.js";
import type { VoiceCallRuntime } from "./runtime.js";
import type { CallRecord } from "./types.js";

describe("voice call command service realtime control", () => {
  it("binds steering to the requester and active call, and keeps guidance for consults", async () => {
    const call: CallRecord = {
      callId: "call-1",
      provider: "mock",
      direction: "outbound",
      state: "active",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: 0,
      transcript: [],
      processedEventIds: [],
      metadata: { requesterSessionKey: "agent:main:owner" },
    };
    const speakRealtime = vi.fn(() => ({ success: true }));
    const updateCallMetadata = vi.fn(async (_call, update, options) => {
      options?.assertCurrent?.();
      call.metadata = update(call.metadata);
    });
    const runtime = {
      config: { realtime: { enabled: true } },
      manager: {
        getCall: (id: string) => (id === call.callId ? call : undefined),
        updateCallMetadata,
      },
      webhookServer: { speakRealtime },
    } as unknown as VoiceCallRuntime;
    const commands = createVoiceCallCommandService(async () => runtime);
    await expect(
      commands.steer({
        callId: "call-1",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:stranger",
      }),
    ).rejects.toThrow("requester");
    await expect(
      commands.steer({
        callId: "call-2",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:owner",
      }),
    ).rejects.toThrow("active");
    expect(speakRealtime).not.toHaveBeenCalled();
    await expect(
      commands.steer({
        callId: "call-1",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:owner",
        mode: "guidance",
      }),
    ).resolves.toEqual({ success: true });
    expect(call.metadata?.ownerInstructions).toEqual(["Ask for Tuesday"]);
    expect(speakRealtime).toHaveBeenCalledWith(
      "call-1",
      expect.stringContaining("Ask for Tuesday"),
    );
    call.state = "completed";
    await expect(
      commands.steer({ callId: "call-1", message: "Too late", operator: true }),
    ).rejects.toThrow("active");
    expect(speakRealtime).toHaveBeenCalledTimes(1);
  });

  it("lets the inbound report session steer classic calls through the provider", async () => {
    const call: CallRecord = {
      callId: "call-in",
      provider: "asterisk",
      direction: "inbound",
      state: "listening",
      from: "+905550001111",
      to: "sim-tr",
      startedAt: 0,
      transcript: [],
      processedEventIds: [],
    };
    const speak = vi.fn(async () => ({ success: true }));
    const speakRealtime = vi.fn(() => ({ success: true }));
    const runtime = {
      config: {
        realtime: { enabled: false },
        reports: { inboundSessionKey: "agent:main:telegram:direct:42" },
      },
      manager: {
        getCall: (id: string) => (id === call.callId ? call : undefined),
        updateCallMetadata: vi.fn(async (_call, update) => {
          call.metadata = update(call.metadata);
        }),
        speak,
      },
      webhookServer: { speakRealtime },
    } as unknown as VoiceCallRuntime;
    const commands = createVoiceCallCommandService(async () => runtime);

    await expect(
      commands.steer({
        callId: "call-in",
        message: "Ask what company they are from",
        requesterSessionKey: "agent:main:telegram:direct:99",
      }),
    ).rejects.toThrow("inbound report session");
    expect(call.metadata?.ownerInstructions).toBeUndefined();

    await expect(
      commands.steer({
        callId: "call-in",
        message: "Ask what company they are from",
        requesterSessionKey: "agent:main:telegram:direct:42",
      }),
    ).resolves.toEqual({ success: true });
    expect(call.metadata?.ownerInstructions).toEqual(["Ask what company they are from"]);
    expect(speak).not.toHaveBeenCalled();

    await expect(
      commands.steer({
        callId: "call-in",
        message: "He will call you back tomorrow",
        mode: "say",
        requesterSessionKey: "agent:main:telegram:direct:42",
      }),
    ).resolves.toEqual({ success: true });
    expect(speak).toHaveBeenCalledWith("call-in", "He will call you back tomorrow");
    expect(speakRealtime).not.toHaveBeenCalled();
  });

  it("keeps inbound calls operator-only without an inbound report session", async () => {
    const call: CallRecord = {
      callId: "call-in",
      provider: "asterisk",
      direction: "inbound",
      state: "active",
      from: "+905550001111",
      to: "sim-tr",
      startedAt: 0,
      transcript: [],
      processedEventIds: [],
    };
    const speak = vi.fn(async () => ({ success: false, error: "Call has ended" }));
    const runtime = {
      config: { realtime: { enabled: false }, reports: {} },
      manager: {
        getCall: (id: string) => (id === call.callId ? call : undefined),
        updateCallMetadata: vi.fn(async (_call, update) => {
          call.metadata = update(call.metadata);
        }),
        speak,
      },
      webhookServer: { speakRealtime: vi.fn() },
    } as unknown as VoiceCallRuntime;
    const commands = createVoiceCallCommandService(async () => runtime);

    await expect(
      commands.steer({ callId: "call-in", message: "Hi", requesterSessionKey: "agent:main:x" }),
    ).rejects.toThrow("operator");
    await expect(
      commands.steer({ callId: "call-in", message: "Hi", mode: "say", operator: true }),
    ).rejects.toThrow("Call has ended");
  });
});
