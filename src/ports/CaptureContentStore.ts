import type { Buffer } from "node:buffer";

import type { DesktopApplicationCapture } from "../domain/desktop/desktopCapture.js";
import type { DesktopPathState } from "../domain/desktop/desktopStateDiff.js";
import type { ArtifactResourceScope } from "../resources/index.js";

type Omission = DesktopApplicationCapture["state"]["omitted_content"][number];

/** A stored file, or why its bytes were left out. */
export type RetainOutcome =
  | {
      readonly kind: "retained";
      readonly sha256: string;
      readonly size: number;
    }
  | { readonly kind: "omitted"; readonly reason: Omission["reason"] };

/**
 * What the desktop capture workflows ask of the capture's content store: keep
 * the bytes of an observed file or of bytes already read, and close or
 * remove the store when the capture ends. The desktop provider implements it with
 * content-addressed files under the capture directory.
 */
export interface CaptureContentStore {
  /** Where retained content is stored. */
  readonly directory: string;
  /**
   * Copy one regular file if it is still the version the walk recorded and
   * it holds still while read.
   */
  retain(
    path: string,
    expected: DesktopPathState,
    signal?: AbortSignal,
  ): Promise<RetainOutcome>;
  /** Store bytes already read; over the per-file limit or the remaining budget they are omitted. */
  retainBytes(bytes: Buffer): Promise<RetainOutcome>;
  /**
   * Retry every handle whose close failed during a read. A handle that fails
   * again stays owned, and the rejection carries its exact cleanup lease.
   */
  close(): Promise<void>;
  /**
   * Remove every file the store wrote, then its content directory. Rejects
   * when the directory holds anything else or a removal fails.
   */
  discard(): Promise<void>;
}

/** The application capture's prepared content store, with the totals the capture records. */
export interface DesktopCaptureStore extends CaptureContentStore {
  /** Files retained so far. */
  readonly files: number;
  /** Bytes retained so far. */
  readonly bytes: number;
  /** Files whose bytes were left out, and why. */
  readonly omissions: readonly Omission[];
  /** The capture's cleanup owner for read handles whose close failed, and for failed inspection resources. */
  readonly resourceScope: ArtifactResourceScope;
}
