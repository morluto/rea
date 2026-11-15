import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { cdpOriginScopeRefusal } from "./CdpOriginScopeError.js";
import type { CdpConnection } from "./CdpConnection.js";
import { classifyCdpFrameUrl } from "./CdpCaptureDocuments.js";
import { delayWithCancellation } from "./CdpCaptureValues.js";
import type { CdpFrameTree } from "./protocol/CdpFrameTree.js";
import {
  cdpRootDocument,
  type CdpDocumentTracker,
} from "./CdpTargetSession.js";

interface AuthorizedMainFrameOptions {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly operation: BrowserObservationOperation;
  /** A reply already read for another check, used as the first attempt. */
  readonly initial?: CdpFrameTree;
  /**
   * The document already selected for this target. Every reply, including a
   * retry, is compared with it before scope, so a proven change is reported as
   * `target_changed` rather than hidden by a retry or a scope refusal.
   */
  readonly document?: CdpDocumentTracker | undefined;
}

/** Wait for the attached target's main frame to enter its approved origin. */
export const authorizedMainFrame = async ({
  connection,
  sessionId,
  signal,
  allowedOrigins,
  operation,
  initial,
  document,
}: AuthorizedMainFrameOptions): Promise<CdpFrameTree> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tree =
      attempt === 0 && initial !== undefined
        ? initial
        : await connection.send("Page.getFrameTree", {}, sessionId, signal);
    if (document !== undefined) {
      const observedDocument = cdpRootDocument(tree);
      if (observedDocument !== undefined) document.observe(observedDocument);
      if (document.changed)
        throw new BrowserObservationError(operation, "target_changed");
    }
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
