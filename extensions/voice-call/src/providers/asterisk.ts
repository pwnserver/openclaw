import crypto, { timingSafeEqual } from "node:crypto";
import type {
  EndReason,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  WebhookParseOptions,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import { TerminalStates } from "../types.js";
import { createWebhookReplayCache, reserveWebhookReplay } from "../webhook-replay.js";
import type { VoiceCallProvider } from "./base.js";

const asteriskReplayCache = createWebhookReplayCache();

class AsteriskApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AsteriskApiError";
  }
}

/**
 * The mediaserver reports `reason: "hangup"` whenever the Asterisk channel
 * goes away, without knowing which side hung up. Call records only accept
 * EndReason values, and an unknown one fails the save, leaving the call
 * active and holding a maxConcurrentCalls slot.
 */
function toEndReason(reason: unknown): EndReason {
  return typeof reason === "string" && TerminalStates.has(reason as EndReason)
    ? (reason as EndReason)
    : "completed";
}

/**
 * Configuration for the Asterisk provider.
 *
 * The provider communicates with the LRTTC Go mediaserver which sits in front
 * of Asterisk:
 *
 *   OpenClaw  ──HTTP API──►  Go mediaserver  ──ARI──►  Asterisk
 *   OpenClaw  ◄──webhook───  Go mediaserver
 *
 * A single shared secret is used for both directions:
 * - Go → OpenClaw webhooks: HMAC-SHA256 signature in X-Signature header
 * - OpenClaw → Go API calls: Bearer token in Authorization header
 */
export interface AsteriskProviderConfig {
  /** Go mediaserver HTTP API base URL (e.g. "http://host.docker.internal:9081") */
  url: string;
  /** Shared secret for HMAC webhook verification + API bearer auth */
  secret: string;
}

interface AsteriskProviderOptions {
  skipVerification?: boolean;
}

/**
 * Asterisk voice-call provider for the LRTTC mediaserver.
 *
 * Maps the VoiceCallProvider interface to the LRTTC Go mediaserver HTTP API.
 * STT and TTS happen locally on the mediaserver — this provider just
 * orchestrates call flow and forwards events.
 */
export class AsteriskProvider implements VoiceCallProvider {
  readonly name = "asterisk" as const;

  private readonly url: string;
  private readonly secret: string;
  private readonly skipVerification: boolean;

  constructor(config: AsteriskProviderConfig, options?: AsteriskProviderOptions) {
    this.url = config.url.replace(/\/+$/, "");
    this.secret = config.secret;
    this.skipVerification = options?.skipVerification ?? false;
  }

  // ---------------------------------------------------------------------------
  // Webhook verification (Go mediaserver → OpenClaw)
  // ---------------------------------------------------------------------------

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    // Deterministic request key derived from the request material; the
    // mediaserver stamps every payload with a millisecond timestamp, so a
    // repeated key means the same delivery arrived twice.
    const requestKey = `asterisk:${crypto
      .createHash("sha256")
      .update(`${ctx.method}\n${ctx.url}\n${ctx.rawBody}`)
      .digest("hex")}`;

    if (this.skipVerification) {
      return {
        ok: true,
        reason: "verification skipped (dev mode)",
        ...reserveWebhookReplay(asteriskReplayCache, requestKey),
      };
    }

    const signature =
      typeof ctx.headers["x-signature"] === "string" ? ctx.headers["x-signature"] : undefined;
    if (!signature) {
      return { ok: false, reason: "Missing X-Signature header" };
    }

    const expected = crypto.createHmac("sha256", this.secret).update(ctx.rawBody).digest("hex");

    // Constant-time comparison
    try {
      const sigBuf = Buffer.from(signature, "hex");
      const expBuf = Buffer.from(expected, "hex");
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return { ok: false, reason: "Invalid HMAC signature" };
      }
    } catch {
      return { ok: false, reason: "Malformed signature" };
    }

    return { ok: true, ...reserveWebhookReplay(asteriskReplayCache, requestKey) };
  }

  // ---------------------------------------------------------------------------
  // Webhook event parsing (Go mediaserver → NormalizedEvent[])
  // ---------------------------------------------------------------------------

  parseWebhookEvent(
    ctx: WebhookContext,
    _options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const payload = JSON.parse(ctx.rawBody) as {
        event: string;
        callId: string;
        timestamp: number;
        data?: Record<string, unknown>;
      };

      const event = this.toNormalizedEvent(payload);
      if (!event) {
        return { events: [], statusCode: 200 };
      }

      return { events: [event], statusCode: 200 };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  private toNormalizedEvent(payload: {
    event: string;
    callId: string;
    timestamp: number;
    data?: Record<string, unknown>;
  }): NormalizedEvent | null {
    const { event, callId, timestamp, data } = payload;
    if (!event || !callId) {
      return null;
    }

    const ts = typeof timestamp === "number" ? timestamp : Date.now();
    const id = `ast-${callId}-${event}-${ts}`;
    const base = {
      id,
      dedupeKey: id,
      callId,
      providerCallId: callId,
      timestamp: ts,
    };

    switch (event) {
      case "call.initiated":
        return {
          ...base,
          type: "call.initiated" as const,
          from: data?.from as string | undefined,
          to: data?.to as string | undefined,
          direction: data?.direction === "outbound" ? ("outbound" as const) : ("inbound" as const),
        };

      case "call.ringing":
        return { ...base, type: "call.ringing" as const };

      case "call.answered":
        return { ...base, type: "call.answered" as const };

      case "call.active":
        return { ...base, type: "call.active" as const };

      case "call.speech":
        return {
          ...base,
          type: "call.speech" as const,
          transcript: (data?.transcript as string) ?? "",
          isFinal: (data?.isFinal as boolean) ?? true,
          confidence: data?.confidence as number | undefined,
        };

      case "call.dtmf":
        return {
          ...base,
          type: "call.dtmf" as const,
          digits: (data?.digits as string) ?? "",
        };

      case "call.ended":
        return {
          ...base,
          type: "call.ended" as const,
          reason: toEndReason(data?.reason),
        };

      case "call.error":
        return {
          ...base,
          type: "call.error" as const,
          error: (data?.error as string) ?? "unknown error",
          retryable: data?.retryable as boolean | undefined,
        };

      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Call control (OpenClaw → Go mediaserver HTTP API)
  // ---------------------------------------------------------------------------

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const resp = await this.apiCall<{ call_id: string; status: string }>("/api/call/initiate", {
      call_id: input.callId,
      from: input.from,
      to: input.to,
    });

    return {
      providerCallId: resp.call_id ?? input.callId,
      status: "initiated",
    };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    try {
      await this.apiCall("/api/call/hangup", {
        session_id: input.providerCallId,
      });
    } catch (err) {
      // 404: the mediaserver session is already gone, so the call is over.
      if (err instanceof AsteriskApiError && err.status === 404) {
        return;
      }
      throw err;
    }
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    await this.apiCall("/api/call/speak", {
      session_id: input.providerCallId,
      text: input.text,
    });
  }

  async startListening(input: StartListeningInput): Promise<void> {
    await this.apiCall("/api/call/listen", {
      session_id: input.providerCallId,
      listening: true,
    });
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    await this.apiCall("/api/call/listen", {
      session_id: input.providerCallId,
      listening: false,
    });
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    let resp: { status?: string; is_terminal?: boolean };
    try {
      resp = await this.apiCall(
        `/api/call/${encodeURIComponent(input.providerCallId)}/status`,
        null,
        "GET",
      );
    } catch {
      // Network / 5xx: keep the call and let timers decide (VoiceCallProvider contract).
      return { status: "unknown", isTerminal: false, isUnknown: true };
    }
    // The mediaserver answers "not_found" + is_terminal=true once the session is gone.
    return {
      status: resp.status ?? "unknown",
      isTerminal: resp.is_terminal ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP helper
  // ---------------------------------------------------------------------------

  private async apiCall<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    method = "POST",
  ): Promise<T> {
    const url = `${this.url}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secret}`,
    };

    const init: RequestInit = { method, headers };
    if (body != null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const resp = await fetch(url, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new AsteriskApiError(
        `Asterisk API ${method} ${path}: ${resp.status} ${text}`,
        resp.status,
      );
    }

    return resp.json() as Promise<T>;
  }
}
