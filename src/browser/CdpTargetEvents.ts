import type { CdpReceivedEvent } from "./CdpConnection.js";

/** Match ordinary session envelopes and root detachment's parameter-scoped session identity. */
export const cdpTargetEventMatches = (
  event: CdpReceivedEvent,
  sessionId: string | undefined,
): boolean => {
  if (event.registered?.method !== "Target.detachedFromTarget")
    return event.sessionId === sessionId;
  return (
    sessionId !== undefined && event.registered.payload.sessionId === sessionId
  );
};
