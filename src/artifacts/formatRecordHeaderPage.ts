import type { ArtifactFormatId } from "../domain/artifactGraph.js";
import type { ArtifactFormatMetadata } from "../domain/artifactFormatMetadata.js";
import type { AnalysisPartialObservation } from "../domain/analysisErrorBase.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  type ArtifactResourceOwner,
} from "../resources/index.js";
import { createArtifactReader } from "./createArtifactReader.js";
import type { FormatRecordHeader } from "../domain/analysisView/analysisViewParent.js";

/** One page of a root artifact's per-record headers. */
export interface FormatRecordHeaderPageRequest {
  readonly path: string;
  readonly format: string;
  /** The parent inventory's root digest; the file must still match it. */
  readonly sha256: string;
  readonly start: number;
  readonly limit: number;
  readonly signal?: AbortSignal | undefined;
  /** Retains the reader when its cleanup fails. */
  readonly resources?: ArtifactResourceScope | undefined;
}

/**
 * The retained header window of each format whose reader can start it at a
 * selected record. This is the reading half of `format_record_headers`; the
 * domain's list of paged formats is the other, and both name the same formats.
 */
const RECORD_HEADER_WINDOWS: Readonly<
  Partial<
    Record<
      ArtifactFormatId,
      (metadata: ArtifactFormatMetadata) => readonly FormatRecordHeader[]
    >
  >
> = {
  "systemd-journal": (metadata) =>
    metadata.kind === "systemd-journal" ? metadata.object_headers : [],
};

/**
 * Read one page by re-reading the root file with its window started at the
 * page offset. The reader first binds the file to the inventory's digest, so a
 * changed file fails with the typed container-identity failure instead of
 * returning shifted rows. Memory is one read chunk plus one window.
 */
export const readFormatRecordHeaderPage = async (
  request: FormatRecordHeaderPageRequest,
  /**
   * The caller's completed observation of a read page, kept on a cleanup
   * failure so finished work survives a reader that fails to close.
   */
  observe?: (
    items: readonly FormatRecordHeader[],
  ) => AnalysisPartialObservation | undefined,
): Promise<readonly FormatRecordHeader[]> => {
  const window =
    RECORD_HEADER_WINDOWS[request.format as ArtifactFormatId] ?? undefined;
  const reader =
    window === undefined
      ? undefined
      : createArtifactReader(request.path, request.format as ArtifactFormatId, {
          environment: process.env,
          unreadableDirectories: "fail",
          recordHeaderStart: request.start,
        });
  if (window === undefined || reader === undefined)
    throw new ArtifactReaderFailure(
      "unavailable",
      `${request.format} declares no per-record header window to page`,
    );
  const resources = request.resources ?? new ArtifactResourceScope();
  // Entering the scope retries any reader an earlier page failed to close, and
  // refuses this page while that cleanup stays unresolved, so repeated close
  // failures cannot accumulate open descriptors.
  return resources.run(async () => {
    const owner: ArtifactResourceOwner = {
      kind: "reader",
      resource: request.path,
      reader,
    };
    let outcome:
      | {
          readonly kind: "completed";
          readonly value: readonly FormatRecordHeader[];
        }
      | { readonly kind: "failed"; readonly cause: unknown };
    try {
      await reader.prepareContainer?.(request.sha256, request.signal);
      for await (const _entry of reader.entries(request.signal)) {
        // Windowed formats declare no members; traversal builds the window.
      }
      const metadata = reader.formatMetadata?.();
      outcome = {
        kind: "completed",
        value:
          metadata === undefined
            ? []
            : window(metadata).slice(0, Math.max(0, request.limit)),
      };
    } catch (cause: unknown) {
      outcome = { kind: "failed", cause };
    }
    const closed = await resources.release(owner);
    if (closed.kind === "failed")
      throw resources.cleanupFailure(
        outcome.kind === "completed" ? { kind: "completed" } : outcome,
        [closed],
        outcome.kind === "completed" ? observe?.(outcome.value) : undefined,
      );
    if (outcome.kind === "failed") throw outcome.cause;
    return outcome.value;
  });
};
