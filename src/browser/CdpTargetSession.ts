import { BrowserObservationError } from "../domain/browserObservationError.js";
import { type BrowserObservationOperation } from "../domain/browserObservationErrors.js";
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
  limits?: { readonly maxPayloadBytes: number },
): Promise<CdpTargetSession> => {
  const webSocket = cdpTargetWebSocket(discovery, target, operation);
  const connection = await CdpConnection.connect(
    webSocket.url,
    operation,
    signal,
    limits,
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
  const cleanup = new AbortController();
  const timeout = setTimeout(() => cleanup.abort(), 1_000);
  timeout.unref();
  try {
    if (signal?.aborted !== true) {
      for (const domain of enabledDomains) {
        if (cleanup.signal.aborted) break;
        try {
          await connection.send(
            `${domain}.disable`,
            {},
            sessionId,
            cleanup.signal,
          );
        } catch {
          // Best-effort domain cleanup; transport close is the definitive boundary.
        }
      }
    }
    // Cancellation skips optional domain shutdown but still releases the
    // attached session using its independent, bounded cleanup signal.
    if (!cleanup.signal.aborted && sessionId !== undefined)
      try {
        await connection.send(
          "Target.detachFromTarget",
          { sessionId },
          undefined,
          cleanup.signal,
        );
      } catch {
        // Best-effort detach; transport close is the definitive boundary.
      }
  } finally {
    clearTimeout(timeout);
    cleanup.abort();
    await connection.close();
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
