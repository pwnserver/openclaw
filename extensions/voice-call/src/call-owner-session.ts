import type { VoiceCallConfig } from "./config.js";
import type { CallRecord } from "./types.js";

/**
 * Session that owns a call: the requester for calls an agent started, otherwise the
 * configured inbound report session. Reports and live transcripts go here, and this
 * session may steer the call.
 */
export function resolveCallOwnerSession(
  call: CallRecord,
  config: Pick<VoiceCallConfig, "reports">,
): string | undefined {
  const session = call.metadata?.requesterSessionKey;
  return typeof session === "string" && session.trim()
    ? session.trim()
    : call.direction === "inbound"
      ? config.reports.inboundSessionKey
      : undefined;
}
