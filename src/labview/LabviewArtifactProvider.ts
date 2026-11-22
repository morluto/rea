import { readFile, stat } from "node:fs/promises";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { LabviewArtifactPort } from "../ports/labview/LabviewArtifactPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  cancelledBy,
  type AnalysisCancelledError,
} from "../domain/analysisErrorCore.js";
import type {
  InspectLabviewArtifactInput,
  LabviewArtifact,
} from "../domain/labview/labviewArtifact.js";
import { err, ok, type Result } from "../domain/result.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { LABVIEW_PROVIDER_IDENTITY } from "./LabviewProviderIdentity.js";
import { findEmbeddedRsrcContainers } from "./LabviewPeContainer.js";
import { parseLabviewRsrc } from "./LabviewRsrc.js";

const OPERATION = "inspect_labview_artifact";
/** Caller-selected complete artifact bound; this reader never truncates a container. */
const MAX_BYTES = 256 * 1024 * 1024;
const RSRC_MAGIC = "RSRC\r\n";

const inputFailure = (message: string, cause?: unknown): AnalysisInputError =>
  new AnalysisInputError(
    OPERATION,
    cause === undefined ? undefined : { cause },
    [{ path: ["path"], reason: "invalid_format", message }],
  );

/** Stable in-process RSRC inspection without a LabVIEW installation or any execution. */
export class LabviewArtifactProvider implements LabviewArtifactPort {
  readonly identity = LABVIEW_PROVIDER_IDENTITY;

  /** This reader owns no retained resource; close is a no-op for lifecycle parity. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  async inspect(
    input: InspectLabviewArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<LabviewArtifact, AnalysisError>> {
    const cancellation = (): AnalysisCancelledError | undefined => {
      const signal = options?.signal;
      return signal?.aborted === true
        ? cancelledBy(OPERATION, signal)
        : undefined;
    };
    const firstCancellation = cancellation();
    if (firstCancellation !== undefined) return err(firstCancellation);
    let size: number;
    try {
      const facts = await stat(input.path);
      if (!facts.isFile()) return err(inputFailure("Expected a regular file."));
      size = facts.size;
    } catch (cause) {
      return err(
        inputFailure(
          "The selected path is not a readable regular file.",
          cause,
        ),
      );
    }
    if (size > MAX_BYTES)
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "out_of_range",
            message: `The selected artifact is ${String(size)} bytes; this reader accepts at most ${String(MAX_BYTES)} bytes.`,
            maximum: MAX_BYTES,
          },
        ]),
      );
    let bytes: Buffer;
    try {
      bytes = await readFile(input.path);
    } catch (cause) {
      return err(
        inputFailure("The selected artifact could not be read.", cause),
      );
    }
    const laterCancellation = cancellation();
    if (laterCancellation !== undefined) return err(laterCancellation);

    const containers =
      bytes.subarray(0, 6).toString("latin1") === RSRC_MAGIC
        ? [{ offset: 0, bytes }]
        : findEmbeddedRsrcContainers(bytes);
    if (containers.length === 0)
      return err(
        inputFailure(
          "The selected file is not a LabVIEW RSRC container and carries no embedded RSRC resource.",
        ),
      );
    const chosen = containers.reduce((largest, candidate) =>
      candidate.bytes.length > largest.bytes.length ? candidate : largest,
    );
    const parsed = parseLabviewRsrc(Buffer.from(chosen.bytes));
    if (!parsed.ok)
      return err(
        inputFailure(
          `The selected LabVIEW RSRC container could not be parsed: ${parsed.reason}.`,
        ),
      );
    const value = parsed.value;
    const sha256 = sha256Hex(bytes);
    const limitations = [
      "Stored section bytes are inventoried; only zlib-coded sections are decoded, and no section payload is returned.",
      ...(value.blockDiagram === "absent"
        ? [
            "The block-diagram heap block (BDH*) is absent; source-level block diagrams are not present in this artifact.",
          ]
        : []),
      ...(value.frontPanel === "absent"
        ? [
            "The front-panel heap block (FPH*) is absent; front-panel object details are not present in this artifact.",
          ]
        : []),
    ];
    return ok({
      artifact: { path: input.path, sha256, bytes: bytes.length },
      container: {
        kind: chosen.offset === 0 ? "rsrc" : "pe-rcdata-rsrc",
        embedded_containers: containers.length,
        format_version: value.formatVersion,
        file_type: value.fileType,
        creator: value.creator,
        data_offset: value.dataOffset,
        data_bytes: value.dataBytes,
        info_offset: value.infoOffset,
        info_bytes: value.infoBytes,
      },
      labview_version: value.labviewVersion,
      block_diagram: value.blockDiagram,
      front_panel: value.frontPanel,
      blocks: value.blocks.map((block) => ({
        identifier: block.identifier,
        sections: block.sections.map((section) => ({
          index: section.index,
          name: section.name,
          stored_bytes: section.storedBytes,
          decoded_bytes: section.decodedBytes,
          coding: section.coding,
        })),
      })),
      limitations,
    });
  }
}
