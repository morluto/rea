import {
  AnalysisCancelledError,
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
    if (signal?.aborted === true) throw new AnalysisCancelledError(operation);
    const attached = await connection.send(
      "Target.attachToTarget",
      { targetId: target.id, flatten: true },
      undefined,
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
): Promise<void> => {
  const { connection, sessionId } = targetSession;
  for (const domain of enabledDomains)
    try {
      await connection.send(`${domain}.disable`, {}, sessionId);
    } catch {
      // Cleanup continues to the detach or direct-socket close boundary.
    }
  if (sessionId !== undefined)
    try {
      await connection.send("Target.detachFromTarget", { sessionId });
    } catch {
      // Closing REA's socket is the final non-destructive cleanup boundary.
    }
  await connection.close();
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
    value.sessionId.length === 0 ||
    value.sessionId.length > 256
  )
    throw new BrowserObservationError(operation, "protocol_error");
  return value.sessionId;
};
