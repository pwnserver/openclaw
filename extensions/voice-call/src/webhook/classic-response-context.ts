import { buildCallBriefInstructions } from "../call-brief.js";
import { resolveCallAgentId } from "../resolve-call-agent-id.js";
import type { CallRecord } from "../types.js";

/**
 * Per-call inputs for the classic (transcript -> agent -> TTS) voice reply.
 *
 * Pass the live call record: owner steering (ownerInstructions) added
 * mid-call must reach the next turn, the same way the realtime path
 * rebuilds its instructions from the record.
 */
export function buildClassicVoiceResponseContext(call: CallRecord) {
  return {
    sessionKey: call.sessionKey,
    from: call.from,
    senderIsOwner: call.direction === "inbound" ? false : undefined,
    agentId: resolveCallAgentId(call),
    transcript: call.transcript,
    callInstructions: buildCallBriefInstructions(call),
  };
}
