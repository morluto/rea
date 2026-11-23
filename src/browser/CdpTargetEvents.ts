import type {
  CdpConnection,
  CdpReceivedEvent,
  CdpTransportEvent,
} from "./CdpConnection.js";

/** Match ordinary session envelopes and root detachment's parameter-scoped session identity. */
const targetEventMatches = (
  event: CdpReceivedEvent,
  sessionId: string | undefined,
): boolean => {
  if (event.registered?.method !== "Target.detachedFromTarget")
    return event.sessionId === sessionId;
  return (
    sessionId !== undefined && event.registered.payload.sessionId === sessionId
  );
};

/**
 * Subscribe to one target's events. A flat session's events carry its
 * `sessionId`; a page socket's carry none. The browser reports the target's
 * detachment on the root session, naming the detached session in its payload,
 * so that event is routed here too. Every target subscriber routes through
 * this owner rather than comparing envelope session IDs itself.
 */
export const onCdpTargetEvent = (
  connection: Pick<CdpConnection, "onEvent">,
  sessionId: string | undefined,
  listener: (event: CdpTransportEvent) => void,
): (() => void) =>
  connection.onEvent((event) => {
    if (targetEventMatches(event, sessionId)) listener(event);
  });
