import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { CdpConnection } from "./CdpConnection.js";
import { mainFrameUrl } from "./CdpCaptureDocuments.js";
import {
  allowedSanitizedUrl,
  delayWithCancellation,
  isHttpUrl,
} from "./CdpCaptureValues.js";

interface AuthorizedMainFrameOptions {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly delayOperation: BrowserObservationOperation;
}

/** Wait for the attached target's main frame to enter its approved origin. */
export const authorizedMainFrame = async ({
  connection,
  sessionId,
  signal,
  allowedOrigins,
  delayOperation,
}: AuthorizedMainFrameOptions): Promise<unknown> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await connection.send(
      "Page.getFrameTree",
      {},
      sessionId,
      signal,
    );
    const url = mainFrameUrl(result);
    if (allowedSanitizedUrl(url, allowedOrigins) !== undefined) return result;
    if (isHttpUrl(url))
      throw new BrowserObservationError(
        "inspect_web_page",
        "target_not_allowed",
      );
    await delayWithCancellation(25, delayOperation, signal);
  }
  throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
};
