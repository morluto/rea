import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { cdpOriginScopeRefusal } from "./CdpOriginScopeError.js";
import type { CdpConnection } from "./CdpConnection.js";
import { classifyCdpFrameUrl } from "./CdpCaptureDocuments.js";
import { delayWithCancellation } from "./CdpCaptureValues.js";
import type { CdpFrameTree } from "./protocol/CdpFrameTree.js";

interface AuthorizedMainFrameOptions {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly operation: BrowserObservationOperation;
}

/** Wait for the attached target's main frame to enter its approved origin. */
export const authorizedMainFrame = async ({
  connection,
  sessionId,
  signal,
  allowedOrigins,
  operation,
}: AuthorizedMainFrameOptions): Promise<CdpFrameTree> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tree = await connection.send(
      "Page.getFrameTree",
      {},
      sessionId,
      signal,
    );
    const observed = tree.root.url;
    const facts = classifyCdpFrameUrl(observed, allowedOrigins);
    if (facts.scope === "outside_policy")
      throw cdpOriginScopeRefusal(operation);
    if (facts.scope === "approved" && observed.kind === "invalid_fragment")
      throw new BrowserObservationError(operation, "protocol_error");
    if (facts.url !== undefined) return tree;
    // Unsupported or missing base evidence cannot establish a policy exit.
    // Keep the bounded startup retry even when the fragment is malformed.
    await delayWithCancellation(25, operation, signal);
  }
  throw new BrowserObservationError(operation, "target_not_allowed");
};
