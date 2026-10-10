import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { CdpConnection } from "./CdpConnection.js";
import { mainFrameUrl } from "./CdpCaptureDocuments.js";
import {
  allowedSanitizedUrl,
  cdpStringValue,
  delayWithCancellation,
  isHttpUrl,
  recordValue,
} from "./CdpCaptureValues.js";

interface AuthorizedMainFrameOptions {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly targetId: string;
  readonly signal: AbortSignal | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly operation: BrowserObservationOperation;
}

export interface CdpMainFrameSnapshot {
  readonly frameTree: unknown;
  readonly reportedUrl: string | undefined;
  readonly url: string | undefined;
  readonly urlSource: "frame_tree" | "target_info";
}

export const MASKED_MAIN_FRAME_LIMITATION =
  "Chromium masked the main-frame URL in Page.getFrameTree; REA authorized and attributed the root frame using Target.getTargetInfo for the same attached target.";
export const MASKED_MAIN_FRAME_EVENT_LIMITATION =
  "Chromium reported an opaque main-frame URL during navigation; REA retained the destination as unknown and requires an attached-target recheck before reporting a final URL.";

interface ReconcileMainFrameOptions {
  readonly frameTree: unknown;
  readonly targetId: string;
  readonly operation: BrowserObservationOperation;
  readonly getTargetInfo: () => Promise<unknown>;
  readonly getFrameTree: () => Promise<unknown>;
}

/** Reconcile Chromium's exact opaque root placeholder with current target identity. */
export const reconcileMainFrame = async ({
  frameTree,
  targetId,
  operation,
  getTargetInfo,
  getFrameTree,
}: ReconcileMainFrameOptions): Promise<CdpMainFrameSnapshot> => {
  const reportedUrl = mainFrameUrl(frameTree);
  if (reportedUrl !== ":")
    return {
      frameTree,
      reportedUrl,
      url: reportedUrl,
      urlSource: "frame_tree",
    };
  const targetInfo = recordValue(
    recordValue(await getTargetInfo())?.targetInfo,
  );
  const observedTargetId = cdpStringValue(targetInfo?.targetId);
  const url = cdpStringValue(targetInfo?.url);
  if (observedTargetId !== targetId || url === undefined)
    throw new BrowserObservationError(operation, "protocol_error");
  const confirmedFrameTree = await getFrameTree();
  const confirmedUrl = mainFrameUrl(confirmedFrameTree);
  if (confirmedUrl !== ":")
    return {
      frameTree: confirmedFrameTree,
      reportedUrl: confirmedUrl,
      url: confirmedUrl,
      urlSource: "frame_tree",
    };
  const identity = mainFrameIdentity(frameTree);
  if (
    identity === undefined ||
    identity !== mainFrameIdentity(confirmedFrameTree)
  )
    return {
      frameTree: confirmedFrameTree,
      reportedUrl: confirmedUrl,
      url: undefined,
      urlSource: "frame_tree",
    };
  const confirmedTargetInfo = recordValue(
    recordValue(await getTargetInfo())?.targetInfo,
  );
  const confirmedTargetId = cdpStringValue(confirmedTargetInfo?.targetId);
  const confirmedTargetUrl = cdpStringValue(confirmedTargetInfo?.url);
  if (confirmedTargetId !== targetId || confirmedTargetUrl === undefined)
    throw new BrowserObservationError(operation, "protocol_error");
  if (confirmedTargetUrl !== url)
    return {
      frameTree: confirmedFrameTree,
      reportedUrl: confirmedUrl,
      url: undefined,
      urlSource: "frame_tree",
    };
  return {
    frameTree: confirmedFrameTree,
    reportedUrl: confirmedUrl,
    url,
    urlSource: "target_info",
  };
};

const mainFrameIdentity = (frameTree: unknown): string | undefined => {
  const frame = recordValue(
    recordValue(recordValue(frameTree)?.frameTree)?.frame,
  );
  const frameId = cdpStringValue(frame?.id);
  const loaderId = cdpStringValue(frame?.loaderId);
  return frameId === undefined || loaderId === undefined
    ? undefined
    : `${frameId}\0${loaderId}`;
};

const readMainFrame = async (
  options: AuthorizedMainFrameOptions,
): Promise<CdpMainFrameSnapshot> => {
  const { connection, sessionId, signal, targetId, operation } = options;
  const frameTree = await connection.send(
    "Page.getFrameTree",
    {},
    sessionId,
    signal,
  );
  return await reconcileMainFrame({
    frameTree,
    targetId,
    operation,
    getTargetInfo: () =>
      connection.send("Target.getTargetInfo", {}, sessionId, signal),
    getFrameTree: () =>
      connection.send("Page.getFrameTree", {}, sessionId, signal),
  });
};

/** Wait for the attached target's main frame to enter its approved origin. */
export const authorizedMainFrame = async ({
  connection,
  sessionId,
  targetId,
  signal,
  allowedOrigins,
  operation,
}: AuthorizedMainFrameOptions): Promise<CdpMainFrameSnapshot> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = await readMainFrame({
      connection,
      sessionId,
      targetId,
      signal,
      allowedOrigins,
      operation,
    });
    const { url } = snapshot;
    if (allowedSanitizedUrl(url, allowedOrigins) !== undefined) return snapshot;
    if (isHttpUrl(url))
      throw new BrowserObservationError(operation, "target_not_allowed");
    await delayWithCancellation(25, operation, signal);
  }
  throw new BrowserObservationError(operation, "target_not_allowed");
};
