import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { LabviewArtifactPort } from "../ports/labview/LabviewArtifactPort.js";
import { ArtifactResourceScope } from "../resources/index.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  cancelledBy,
  type AnalysisCancelledError,
} from "../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import type {
  InspectLabviewArtifactInput,
  LabviewArtifact,
  LabviewArtifactPresence,
} from "../domain/labview/labviewArtifact.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import {
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  artifactFixedLimitFailure,
  completedStableArtifactObservation,
  readStableArtifact,
  translateArtifactFailure,
} from "../resources/index.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import { LABVIEW_RSRC_MAGIC } from "../domain/labview/labviewArtifact.js";
import { LABVIEW_PROVIDER_IDENTITY } from "./LabviewProviderIdentity.js";
import {
  findEmbeddedRsrcContainers,
  type EmbeddedRsrc,
} from "./LabviewPeContainer.js";
import {
  LABVIEW_DECODE_ALLOWANCES,
  type LabviewDecodeOmission,
  type LabviewPresence,
  parseLabviewRsrc,
} from "./LabviewRsrc.js";

const OPERATION = "inspect_labview_artifact";
/** Caller-selected complete artifact bound; this reader never truncates a container. */
const MAX_BYTES = 256 * 1024 * 1024;
/**
 * One limitation per reason a recognized zlib section stayed undecoded, so a
 * capacity omission is distinguishable from damaged or unsupported bytes.
 */
export const decodeOmissionLimitations = (
  omissions: Readonly<Partial<Record<LabviewDecodeOmission, number>>>,
): string[] =>
  (Object.entries(omissions) as [LabviewDecodeOmission, number][]).map(
    ([reason, count]) => {
      const sections =
        count === 1 ? "1 zlib section" : `${String(count)} zlib sections`;
      const verb = count === 1 ? "was" : "were";
      const declares = count === 1 ? "declares" : "declare";
      const carries = count === 1 ? "carries" : "carry";
      const does = count === 1 ? "does" : "do";
      switch (reason) {
        case "preset_dictionary":
          return `${sections} ${declares} a zlib preset dictionary (FDICT) that the container does not supply, so ${count === 1 ? "it was" : "they were"} not decoded.`;
        case "compressed_allowance":
        case "decoded_allowance":
          return `${sections} ${verb} not decoded because the container reached its fixed ${String(LABVIEW_DECODE_ALLOWANCES[reason])}-byte ${reason === "compressed_allowance" ? "compressed-input" : "decoded-output"} allowance. This release has no override; the stored bytes are inventoried but not decoded.`;
        case "inflate_failed":
          return `${sections} ${carries} a zlib header but ${does} not inflate to the declared length, so ${count === 1 ? "it was" : "they were"} not decoded.`;
      }
    },
  );

/** Release-fixed input ceiling, stated so the refusal keeps its recovery. */
const INPUT_ALLOWANCE = {
  kind: "input",
  name: "The 256 MiB LabVIEW artifact input allowance",
  limit: MAX_BYTES,
  unit: "bytes",
} as const;

const inputFailure = (message: string, cause?: unknown): AnalysisInputError =>
  new AnalysisInputError(
    OPERATION,
    cause === undefined ? undefined : { cause },
    [{ path: ["path"], reason: "invalid_format", message }],
  );

/** Display name for one deterministic parser or walk allowance. */
const allowanceName = (name: string): string => {
  switch (name) {
    case "labview_rsrc_blocks":
      return "The LabVIEW RSRC block allowance";
    case "labview_rsrc_sections_per_block":
      return "The LabVIEW RSRC per-block section allowance";
    case "labview_rsrc_total_sections":
      return "The LabVIEW RSRC total section allowance";
    case "pe_resource_directory_visits":
      return "The PE resource-directory walk allowance";
    case "pe_resource_directory_entries":
      return "The PE resource-directory entry allowance";
    case "pe_resource_entries":
      return "The PE resource entry allowance";
    case "pe_embedded_rsrc_containers":
      return "The embedded RSRC container allowance";
    default:
      return "The LabVIEW inspection allowance";
  }
};

/** The limit this parse error stopped at, if it stopped at one. */
const limitCause = (
  error: ParseFailureError,
): ParseFailureError<"limit"> | undefined =>
  error.failure.kind === "limit"
    ? (error as ParseFailureError<"limit">)
    : undefined;

/**
 * How this reader classifies a failed read: the shared classifier owns
 * cancellation, cleanup retention, and path/format projection, and this
 * dialect supplies only the LabVIEW-specific raw causes.
 */
export const labviewReadDialect = (path: string): ProviderFailureDialect => ({
  providerId: LABVIEW_PROVIDER_IDENTITY.id,
  operation: OPERATION,
  file: {
    path,
    description: "LabVIEW artifact",
    // The read's identity survives a later refusal or a failed close.
    retainCompletedIdentity: true,
    // Restate the release-fixed ceiling as an allowance with its recovery.
    fileSize: (_failure, details) =>
      translateArtifactFailure(
        OPERATION,
        path,
        artifactFixedLimitFailure(
          INPUT_ALLOWANCE,
          `The selected artifact exceeds the ${String(MAX_BYTES)}-byte LabVIEW input allowance: ${path}`,
          "file-size",
          details,
        ),
      ),
  },
  unclassified: (cause) => translateArtifactFailure(OPERATION, path, cause),
});

/** One parser or walk limit, with the fixed allowance that owns its recovery. */
const limitFailure = (cause: ParseFailureError<"limit">) => {
  const { format, limit } = cause.failure;
  return parseLimitConstraint(OPERATION, "capacity", cause, {
    diagnostics: { format, kind: "limit", boundary: limit.name },
    ...fixedAllowanceOptions(allowanceName(limit.name), "count", {
      limit: limit.maximum,
      unit: "entries",
    }),
  });
};

/** Stable in-process RSRC inspection without a LabVIEW installation or any execution. */
export class LabviewArtifactProvider implements LabviewArtifactPort {
  readonly identity = LABVIEW_PROVIDER_IDENTITY;
  readonly #resources: ArtifactResourceScope;
  readonly #ownsResources: boolean;

  /**
   * The scope owns descriptor cleanup whose close could not be proved. A caller
   * that already tracks artifact resources may pass theirs; otherwise this
   * reader owns one, and closing the provider closes it.
   */
  constructor(resources?: ArtifactResourceScope) {
    this.#resources = resources ?? new ArtifactResourceScope();
    this.#ownsResources = resources === undefined;
  }

  /** Release an owned scope; a caller-supplied scope stays with its owner. */
  close(): Promise<void> {
    return this.#ownsResources ? this.#resources.close() : Promise.resolve();
  }

  async inspect(
    input: InspectLabviewArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<LabviewArtifact, AnalysisError>> {
    const signal = options?.signal;
    const cancellation = (): AnalysisCancelledError | undefined =>
      signal?.aborted === true ? cancelledBy(OPERATION, signal) : undefined;
    const firstCancellation = cancellation();
    if (firstCancellation !== undefined) return err(firstCancellation);

    // One stable read binds identity and size to the bytes actually inspected,
    // and rejects a replacement or in-place change between admission and read.
    let snapshot: { readonly bytes: Buffer; readonly sha256: string };
    try {
      snapshot = await this.#resources.run(() =>
        readStableArtifact(
          input.path,
          MAX_BYTES,
          signal,
          undefined,
          this.#resources,
        ),
      );
    } catch (cause) {
      // The stable read records its own cancellation and cleanup facts. Only
      // the release-fixed input ceiling needs this provider's own allowance.
      return err(
        classifyProviderFailure(cause, labviewReadDialect(input.path)),
      );
    }
    // A later refusal still belongs to the bytes already read.
    const withIdentity = (error: AnalysisError): AnalysisError => {
      const observation = completedStableArtifactObservation(
        error,
        input.path,
        snapshot,
      );
      if (observation !== undefined)
        error.retainPartialObservation(observation);
      return error;
    };
    const laterCancellation = cancellation();
    if (laterCancellation !== undefined)
      return err(withIdentity(laterCancellation));

    const bytes = snapshot.bytes;
    let containers: readonly EmbeddedRsrc[];
    let coverage = true;
    if (
      bytes.subarray(0, LABVIEW_RSRC_MAGIC.length).toString("latin1") ===
      LABVIEW_RSRC_MAGIC
    ) {
      containers = [{ offset: 0, bytes }];
    } else {
      const scan = findEmbeddedRsrcContainers(bytes);
      if (!scan.ok) return err(withIdentity(limitFailure(scan.failure)));
      containers = scan.containers;
      coverage = scan.complete;
    }
    if (containers.length === 0)
      return err(
        withIdentity(
          inputFailure(
            coverage
              ? "The selected file is not a LabVIEW RSRC container and carries no embedded RSRC resource."
              : "No embedded RSRC container was located, but part of the PE resource tree could not be read, so one may still be present. The tree is malformed or points outside the file-backed resource span.",
          ),
        ),
      );
    const chosen = containers.reduce((largest, candidate) =>
      candidate.bytes.length > largest.bytes.length ? candidate : largest,
    );
    const parsed = parseLabviewRsrc(chosen.bytes, chosen.offset);
    if (!parsed.ok) {
      const limit = limitCause(parsed.failure);
      if (limit !== undefined) return err(withIdentity(limitFailure(limit)));
      const error = parseFailureAnalysisError(
        OPERATION,
        input.path,
        parsed.failure,
      );
      if (error !== undefined) return err(withIdentity(error));
      throw parsed.failure;
    }
    const value = parsed.value;

    // The parser owns these block facts; this layer decides only whether an
    // unobserved heap can be called absent.
    // A container that carries an embedded program tree, or a file whose other
    // containers were not examined, cannot establish that a heap is absent.
    // A direct RSRC file's content does not say whether it is a VI, a control,
    // or an archive whose member VIs were not opened, so absence is not claimed
    // there either; the caller's spelling is not evidence of format.
    const directContainer = chosen.offset === 0;
    const unexamined =
      containers.length > 1 ||
      directContainer ||
      !coverage ||
      value.programTree;
    const presence = (observed: LabviewPresence): LabviewArtifactPresence =>
      observed === "present" ? "present" : unexamined ? "unknown" : "absent";
    const blockDiagram = presence(value.blockDiagram);
    const frontPanel = presence(value.frontPanel);

    const limitations = [
      "Stored section bytes are inventoried; only zlib-coded sections are decoded, and no section payload is returned.",
      ...(containers.length > 1
        ? [
            `The file carries ${String(containers.length)} embedded RSRC containers; only the largest was inventoried, and the others were not examined.`,
          ]
        : []),
      ...(directContainer
        ? [
            "The selected file is a direct RSRC container: this reader cannot establish from its content whether it is a VI, a control, or an .llb archive whose member VIs were not opened.",
          ]
        : []),
      ...(coverage
        ? []
        : [
            "Part of the PE resource tree could not be examined, so heap presence is unknown for that content.",
          ]),
      ...decodeOmissionLimitations(value.decodeOmissions),
      ...(value.versionCoverage === "unknown"
        ? [
            "The container has a vers section whose content could not be decoded, so the version is unknown rather than absent.",
          ]
        : []),
      ...(value.programTree
        ? [
            "The inspected container carries an embedded program tree (LVzp) that this reader does not decode.",
          ]
        : []),
      ...(blockDiagram === "absent"
        ? [
            "The inspected container has no block-diagram heap block (BDH*); source-level block diagrams are not present in that container.",
          ]
        : blockDiagram === "unknown"
          ? [
              "No block-diagram heap block (BDH*) was found in the inspected container, and unexamined content could still hold one, so diagram presence is unknown.",
            ]
          : []),
      ...(frontPanel === "absent"
        ? [
            "The inspected container has no front-panel heap block (FPH*); front-panel object details are not present in that container.",
          ]
        : frontPanel === "unknown"
          ? [
              "No front-panel heap block (FPH*) was found in the inspected container, and unexamined content could still hold one, so front-panel presence is unknown.",
            ]
          : []),
    ];
    return ok({
      artifact: {
        path: input.path,
        sha256: snapshot.sha256,
        bytes: bytes.length,
      },
      container: {
        kind: chosen.offset === 0 ? "rsrc" : "pe-rcdata-rsrc",
        embedded_containers: containers.length,
        file_offset: chosen.offset,
        format_version: value.formatVersion,
        file_type: value.fileType,
        creator: value.creator,
        data_offset: value.dataOffset,
        data_bytes: value.dataBytes,
        info_offset: value.infoOffset,
        info_bytes: value.infoBytes,
      },
      labview_version: value.labviewVersion,
      version_coverage: value.versionCoverage,
      block_diagram: blockDiagram,
      front_panel: frontPanel,
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
