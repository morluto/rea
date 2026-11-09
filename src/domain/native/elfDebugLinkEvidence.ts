import { BINARY_ARCHITECTURES } from "../binaryTargetTypes.js";
import { elfArchitecture } from "../elfFixedHeader.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceProvider,
} from "../evidence.js";
import type { ElfDebugLink, InspectElfDebugLinkInput } from "./elfDebugLink.js";

/** One file-offset range declared by a decoded linkage section. */
export type ElfDebugLinkRange = {
  readonly offset: number;
  readonly bytes: number;
};

/** File-offset ranges of the decoded debuglink, debugaltlink and debugdata sections. */
export const elfDebugLinkRanges = (report: ElfDebugLink): ElfDebugLinkRange[] =>
  [
    report.debuglink.location,
    report.debugaltlink.location,
    report.debugdata.location,
  ].filter((range): range is ElfDebugLinkRange => range !== null);

/** One Evidence interpretation for success and reports retained by later candidate failures. */
export const createElfDebugLinkEvidence = (
  report: ElfDebugLink,
  provider: EvidenceProvider,
  parameters: InspectElfDebugLinkInput,
): Evidence => {
  const architecture = BINARY_ARCHITECTURES.find(
    (supported) => supported === elfArchitecture(report.machine),
  );
  return createEvidence(
    {
      path: report.artifact.path,
      format: "elf",
      sha256: report.artifact.sha256,
      ...(architecture === undefined ? {} : { architecture }),
    },
    provider,
    {
      operation: "inspect_elf_debug_link",
      parameters,
      result: report,
      confidence: "observed",
      limitations: report.limitations,
      locations: [
        { kind: "artifact-path" as const, path: report.artifact.path },
        ...(report.candidate === null
          ? []
          : [{ kind: "artifact-path" as const, path: report.candidate.path }]),
        ...elfDebugLinkRanges(report).map((range) => ({
          kind: "file-offset-range" as const,
          start: range.offset,
          end: range.offset + range.bytes,
        })),
      ],
    },
  );
};
