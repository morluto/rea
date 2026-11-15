import {
  CDP_DISCOVERY_RESPONSE_TIMEOUT_MS,
  DEFAULT_CDP_COMMAND_TIMEOUT_MS,
  MAX_BROWSER_DEADLINE_MS,
} from "../domain/browserDeadline.js";
import type { BrowserObservationEndpoint } from "../domain/browserObservation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { CdpConnection } from "./CdpConnection.js";
import type { CdpDomainWith } from "./protocol/CdpCommands.js";
import {
  observedFrameUrl,
  type CdpFrameTree,
} from "./protocol/CdpFrameTree.js";
import {
  CdpTargetSessionOwner,
  bindCdpTransportCleanup,
} from "./CdpTargetSessionOwner.js";
import {
  cdpTargetWebSocket,
  discoverCdpBrowserSocket,
  discoverCdpEndpoint,
  withCdpDiscoveryDeadline,
  type CdpEndpointDiscovery,
  type CdpEndpointTarget,
} from "./CdpEndpoint.js";

/** One CDP connection scoped either by a flat browser session or page socket. */
export interface CdpTargetSession {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
}

/** The committed document a target session selected: root frame, loader and URL. */
export interface CdpDocumentIdentity {
  readonly frameId: string;
  /** Absent when CDP did not report the loader, which leaves the document unproven. */
  readonly loaderId?: string | undefined;
  /** The frame's complete URL, absent when CDP did not report a readable one. */
  readonly url?: string | undefined;
}

/**
 * How a later observation relates to the selected document. Only a different
 * root frame or loader proves `changed`; a missing loader is `unknown`, never a
 * change, and a known unchanged loader at another URL is a same-document
 * navigation. Consumers decide what each outcome means for their evidence.
 */
export type CdpDocumentComparison =
  | "same"
  | "same_document_navigation"
  | "changed"
  | "unknown";

const knownLoader = (loaderId: string | undefined): string | undefined =>
  loaderId === "" ? undefined : loaderId;

/** Compare two observations of the selected target's root document. */
export const compareCdpDocuments = (
  selected: CdpDocumentIdentity,
  observed: CdpDocumentIdentity,
): CdpDocumentComparison => {
  if (selected.frameId !== observed.frameId) return "changed";
  const before = knownLoader(selected.loaderId);
  const after = knownLoader(observed.loaderId);
  if (before === undefined || after === undefined) return "unknown";
  if (before !== after) return "changed";
  return selected.url === observed.url ? "same" : "same_document_navigation";
};

/** The reply root's document, or undefined when the reply cannot identify it. */
export const cdpRootDocument = (
  tree: CdpFrameTree,
): CdpDocumentIdentity | undefined => {
  const { frameId, identityIssue, parentRelation, loaderId, loaderIssue } =
    tree.root.facts;
  if (
    frameId === null ||
    identityIssue !== null ||
    parentRelation !== "root" ||
    loaderIssue !== null
  )
    return undefined;
  return { frameId, loaderId, url: observedFrameUrl(tree.root.url) };
};

/** Coverage note for a document whose loader identity CDP did not report. */
export const unverifiedDocumentLimitation = (
  selected: CdpDocumentIdentity,
): string =>
  `The ${knownLoader(selected.loaderId) === undefined ? "initial" : "final"} document loader identity was unavailable, so document stability could not be verified. Retry after the page finishes loading.`;

/**
 * Tracks the selected document across observations. A change is sticky: once
 * another document was observed, evidence gathered since selection may mix
 * documents. The first identity stays as the evidence subject.
 */
export class CdpDocumentTracker {
  readonly selected: CdpDocumentIdentity;
  #current: CdpDocumentIdentity;
  #changed = false;
  #unknown = false;

  constructor(selected: CdpDocumentIdentity) {
    this.selected = selected;
    this.#current = selected;
  }

  get current(): CdpDocumentIdentity {
    return this.#current;
  }

  /** Another root frame or loader was observed since selection. */
  get changed(): boolean {
    return this.#changed;
  }

  /** Some observation lacked the loader needed to prove the document. */
  get unknown(): boolean {
    return this.#unknown;
  }

  observe(observed: CdpDocumentIdentity): CdpDocumentComparison {
    const comparison = compareCdpDocuments(this.#current, observed);
    if (comparison === "changed") this.#changed = true;
    if (comparison === "unknown") this.#unknown = true;
    // A missing loader does not forget the loader that proved this document.
    this.#current = {
      ...observed,
      loaderId:
        knownLoader(observed.loaderId) ??
        (comparison === "changed" ? undefined : this.#current.loaderId),
    };
    return comparison;
  }
}

/** Discovery for one caller-selected endpoint and the browser socket that read it. */
export interface CdpOpenedEndpoint {
  readonly discovery: CdpEndpointDiscovery;
  /**
   * Browser socket kept for the target session, because a browser may ask
   * the user to approve each socket. HTTP discovery opens no socket.
   */
  readonly connection: CdpConnection | undefined;
  readonly reusableBrowserSocket?: boolean;
}

/**
 * Discover one passive browser endpoint through its selected transport. A
 * browser socket's handshake and discovery share one discovery deadline.
 */
export const openCdpEndpoint = async (
  endpoint: BrowserObservationEndpoint,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
  timeoutMs?: number,
  owner?: CdpTargetSessionOwner,
  commandTimeoutMs?: number,
  options?: { readonly reuseBrowserSocket?: boolean },
): Promise<CdpOpenedEndpoint> => {
  const discoveryTimeoutMs = timeoutMs ?? CDP_DISCOVERY_RESPONSE_TIMEOUT_MS;
  if (endpoint.transport === "http_discovery")
    return {
      discovery: await discoverCdpEndpoint(
        endpoint.url,
        operation,
        signal,
        discoveryTimeoutMs,
      ),
      connection: undefined,
    };
  const reuseBrowserSocket =
    owner !== undefined && options?.reuseBrowserSocket === true;
  // The browser-socket handshake and discovery commands stay on the discovery
  // deadline. The selected command deadline starts only after discovery returns.
  const discoveryGuardTimeoutMs = Math.min(
    MAX_BROWSER_DEADLINE_MS,
    discoveryTimeoutMs + 1_000,
  );
  const discoveryLimits = {
    // Stay past the discovery abort so a stalled open or discovery command is
    // labeled as discovery, not as command_timeout_ms, without overflowing
    // 32-bit timers.
    commandTimeoutMs: discoveryGuardTimeoutMs,
    handshakeTimeoutMs: discoveryGuardTimeoutMs,
  };
  return await withCdpDiscoveryDeadline(
    operation,
    signal,
    async (deadlineSignal) => {
      const acquired = reuseBrowserSocket
        ? await owner.acquireBrowserSocket(
            endpoint.url,
            operation,
            { signal: deadlineSignal },
            discoveryLimits,
          )
        : {
            connection:
              owner === undefined
                ? await CdpConnection.connect(
                    endpoint.url,
                    operation,
                    deadlineSignal,
                    discoveryLimits,
                  )
                : await owner.connect(
                    endpoint.url,
                    operation,
                    { signal: deadlineSignal },
                    "browser-endpoint",
                    discoveryLimits,
                  ),
            reused: false,
          };
      try {
        const discovery = await discoverCdpBrowserSocket(
          acquired.connection,
          endpoint.url,
          operation,
          deadlineSignal,
        );
        const selectedTimeout =
          commandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
        if (reuseBrowserSocket) {
          owner.admitBrowserSocket(endpoint.url, acquired.connection);
          return {
            discovery,
            connection: acquired.connection.withOperation(
              operation,
              selectedTimeout,
            ),
            reusableBrowserSocket: true,
          };
        }
        acquired.connection.selectCommandTimeout(selectedTimeout);
        return {
          discovery,
          connection: acquired.connection,
        };
      } catch (cause: unknown) {
        const releaseLeaseOnly =
          reuseBrowserSocket &&
          deadlineSignal.aborted &&
          cause instanceof AnalysisCancelledError &&
          acquired.connection.isReusable();
        return await failCdpOpenAfterCleanup(
          acquired.connection,
          cause,
          operation,
          owner,
          reuseBrowserSocket
            ? releaseLeaseOnly
              ? "release"
              : "evict"
            : "finish",
        );
      }
    },
    discoveryTimeoutMs,
  );
};

/** Open one authorized target through its supported browser or page transport. */
export const openCdpTargetSession = async (
  discovery: CdpEndpointDiscovery,
  target: CdpEndpointTarget,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
  limits?: {
    readonly maxPayloadBytes?: number;
    readonly commandTimeoutMs?: number;
  },
  owner?: CdpTargetSessionOwner,
): Promise<CdpTargetSession> => {
  const webSocket = cdpTargetWebSocket(discovery, target, operation);
  const connection =
    owner === undefined
      ? await CdpConnection.connect(webSocket.url, operation, signal, limits)
      : await owner.connect(
          webSocket.url,
          operation,
          signal === undefined ? {} : { signal },
          target.id,
          limits,
        );
  if (webSocket.scope === "page") return { connection, sessionId: undefined };
  try {
    return await attachCdpTargetSession(
      connection,
      target,
      operation,
      signal,
      owner,
    );
  } catch (cause: unknown) {
    if (owner === undefined) throw cause;
    return await failCdpOpenAfterCleanup(connection, cause, operation, owner);
  }
};

/** Attach one target through an open browser socket, which the session then owns. */
export const attachCdpTargetSession = async (
  connection: CdpConnection,
  target: CdpEndpointTarget,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
  owner?: CdpTargetSessionOwner,
): Promise<CdpTargetSession> => {
  try {
    const { sessionId } = await connection.send(
      "Target.attachToTarget",
      { targetId: target.id, flatten: true },
      undefined,
      signal,
    );
    return { connection, sessionId };
  } catch (cause: unknown) {
    if (owner === undefined)
      return await failCdpOpenAfterCleanup(connection, cause, operation);
    throw cause;
  }
};

/** Finish failed admission without allowing cleanup to replace its primary. */
export const failCdpOpenAfterCleanup = async (
  connection: CdpConnection,
  primary: unknown,
  operation: BrowserObservationOperation,
  owner?: CdpTargetSessionOwner,
  ownerDisposition: "finish" | "evict" | "release" = "finish",
): Promise<never> => {
  try {
    if (owner === undefined) await connection.close();
    else if (ownerDisposition === "release")
      await owner.releaseBrowserSocket(connection);
    else if (ownerDisposition === "evict")
      await owner.evictBrowserSocket(connection);
    else await owner.finish(connection);
  } catch (cleanup: unknown) {
    throw combineOpenFailure(primary, cleanup, operation);
  }
  throw primary;
};

const combineOpenFailure = (
  primary: unknown,
  cleanup: unknown,
  operation: BrowserObservationOperation,
): unknown =>
  primary instanceof AnalysisError && cleanup instanceof AnalysisError
    ? bindCdpTransportCleanup(
        cleanup,
        analysisErrorWithCleanupFailure(primary, cleanup, operation),
      )
    : new AggregateError(
        [primary, cleanup],
        `CDP operation ${operation} failed and its transport cleanup is incomplete.`,
        { cause: primary },
      );

/** Disable enabled domains, detach browser sessions, and release or close REA's socket. */
export const closeCdpTargetSession = async (
  targetSession: CdpTargetSession,
  enabledDomains: readonly CdpDomainWith<"disable">[],
  signal?: AbortSignal,
  owner?: CdpTargetSessionOwner,
  reuseBrowserSocket = false,
): Promise<void> => {
  if (owner !== undefined) {
    if (reuseBrowserSocket) {
      await owner.releaseBrowserSocket(targetSession.connection, () =>
        cleanupCdpTargetCommands(targetSession, enabledDomains, signal),
      );
      return;
    }
    await owner.finish(targetSession.connection, async () => {
      await cleanupCdpTargetCommands(targetSession, enabledDomains, signal);
    });
    return;
  }
  await cleanupCdpTargetCommands(targetSession, enabledDomains, signal);
  await targetSession.connection.close();
};

const cleanupCdpTargetCommands = async (
  targetSession: CdpTargetSession,
  enabledDomains: readonly CdpDomainWith<"disable">[],
  signal?: AbortSignal,
): Promise<boolean> => {
  const { connection, sessionId } = targetSession;
  const cleanup = new AbortController();
  const domainSignal =
    signal === undefined
      ? cleanup.signal
      : AbortSignal.any([cleanup.signal, signal]);
  const timeout = setTimeout(() => cleanup.abort(), 1_000);
  timeout.unref();
  try {
    if (signal?.aborted !== true) {
      for (const domain of enabledDomains) {
        if (domainSignal.aborted) break;
        try {
          await connection.send(
            `${domain}.disable` as const,
            {},
            sessionId,
            domainSignal,
          );
        } catch {
          // Best-effort domain cleanup; session detachment or transport close follows.
        }
      }
    }
    if (sessionId === undefined) return true;
    // Cancellation skips optional domain shutdown but still releases the
    // attached session using its independent, bounded cleanup signal.
    if (cleanup.signal.aborted) return false;
    try {
      await connection.send(
        "Target.detachFromTarget",
        { sessionId },
        undefined,
        cleanup.signal,
      );
      return true;
    } catch (cause: unknown) {
      if (isAlreadyDetachedSessionRejection(cause)) return true;
      // If detachment is unconfirmed, transport close becomes the definitive boundary.
      return false;
    }
  } finally {
    clearTimeout(timeout);
    cleanup.abort();
  }
};

const isAlreadyDetachedSessionRejection = (cause: unknown): boolean =>
  cause instanceof CdpCommandRejection &&
  (cause.code === -32_001 ||
    (cause.reportedMessage !== null &&
      /no session with given id|session with given id not found/iu.test(
        cause.reportedMessage,
      )));
