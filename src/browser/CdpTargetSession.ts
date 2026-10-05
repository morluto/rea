import {
  BrowserObservationError,
  type BrowserObservationOperation,
} from "../domain/errors.js";
import { CdpConnection } from "./CdpConnection.js";
import {
  cdpTargetWebSocket,
  type CdpEndpointDiscovery,
  type CdpEndpointTarget,
} from "./CdpEndpoint.js";

/** One CDP connection scoped either by a flat browser session or page socket. */
export interface CdpTargetSession {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
}

/** Open one authorized target through its supported browser or page transport. */
export const openCdpTargetSession = async (
  discovery: CdpEndpointDiscovery,
  target: CdpEndpointTarget,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): Promise<CdpTargetSession> => {
  const webSocket = cdpTargetWebSocket(discovery, target, operation);
  const connection = await CdpConnection.connect(
    webSocket.url,
    operation,
    signal,
  );
  if (webSocket.scope === "page") return { connection, sessionId: undefined };
  try {
    const attached = await connection.send(
      "Target.attachToTarget",
      { targetId: target.id, flatten: true },
      undefined,
      signal,
    );
    return { connection, sessionId: attachedSessionId(attached, operation) };
  } catch (cause: unknown) {
    await connection.close();
    throw cause;
  }
};

/** Disable enabled domains, detach browser sessions, and close REA's socket. */
export const closeCdpTargetSession = async (
  targetSession: CdpTargetSession,
  enabledDomains: readonly string[],
  signal?: AbortSignal,
): Promise<void> => {
  const { connection, sessionId } = targetSession;
  for (const [index, domain] of enabledDomains.entries()) {
    if (signal?.aborted === true) {
      await closeCancelledTargetSession(
        targetSession,
        enabledDomains.slice(index),
      );
      return;
    }
    try {
      await connection.send(`${domain}.disable`, {}, sessionId, signal);
    } catch (cause: unknown) {
      // best-effort cleanup: domain disable continues to detach/close boundary.
      void cause;
    }
  }
  if (signal?.aborted === true) {
    await closeCancelledTargetSession(targetSession, []);
    return;
  }
  if (sessionId !== undefined)
    try {
      await connection.send(
        "Target.detachFromTarget",
        { sessionId },
        undefined,
        signal,
      );
    } catch (cause: unknown) {
      // best-effort cleanup: closing REA's socket is the final cleanup boundary.
      void cause;
    }
  await connection.close();
};

const closeCancelledTargetSession = async (
  { connection, sessionId }: CdpTargetSession,
  enabledDomains: readonly string[],
): Promise<void> => {
  const commands = enabledDomains.map((domain) =>
    connection.send(`${domain}.disable`, {}, sessionId),
  );
  if (sessionId !== undefined)
    commands.push(connection.send("Target.detachFromTarget", { sessionId }));
  const settled = Promise.allSettled(commands);
  try {
    await connection.close();
  } finally {
    await settled;
  }
};

const attachedSessionId = (
  value: unknown,
  operation: BrowserObservationOperation,
): string => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0
  )
    throw new BrowserObservationError(operation, "protocol_error");
  return value.sessionId;
};
