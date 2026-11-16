import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";

/** Preserve a producer's command rejection independently from fatal transport parsing errors. */
export class CdpCommandRejection extends BrowserObservationError {
  constructor(
    operation: BrowserObservationOperation,
    readonly command: string,
    readonly code: number | null,
    readonly reportedMessage: string | null,
  ) {
    super(operation, "protocol_error", {
      detail:
        reportedMessage === null
          ? "CDP returned a malformed command error."
          : `CDP ${command} failed (${code === null ? "unknown code" : String(code)}): ${reportedMessage}`,
    });
  }
}

/**
 * CDP confirmed that the command's flat session no longer exists. The target
 * is gone, so nothing REA installed through that session remains to restore.
 */
export const isCdpSessionGoneRejection = (cause: unknown): boolean =>
  cause instanceof CdpCommandRejection &&
  (cause.code === -32_001 ||
    (cause.reportedMessage !== null &&
      /no session with given id|session with given id not found/iu.test(
        cause.reportedMessage,
      )));
