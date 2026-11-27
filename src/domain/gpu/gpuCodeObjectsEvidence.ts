import { unknownTarget } from "../targetIdentity.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceProvider,
} from "../evidence.js";
import type {
  GpuCodeObjects,
  GpuCodeObjectsInput,
  GpuCodeObjectsPartial,
} from "./gpuCodeObjects.js";

const gpuParameters = (parameters: GpuCodeObjectsInput) => ({
  path: parameters.path,
  analysis: parameters.analysis,
  ...(parameters.object_ids === undefined
    ? {}
    : { object_ids: parameters.object_ids }),
  ...(parameters.targets === undefined ? {} : { targets: parameters.targets }),
  ...(parameters.expected_sha256 === undefined
    ? {}
    : { expected_sha256: parameters.expected_sha256 }),
  ...(parameters.max_object_bytes === undefined
    ? {}
    : { max_object_bytes: parameters.max_object_bytes }),
  ...(parameters.max_work_bytes === undefined
    ? {}
    : { max_work_bytes: parameters.max_work_bytes }),
  ...(parameters.max_report_bytes === undefined
    ? {}
    : { max_report_bytes: parameters.max_report_bytes }),
  ...(parameters.max_metadata_bytes === undefined
    ? {}
    : { max_metadata_bytes: parameters.max_metadata_bytes }),
  ...(parameters.max_structure_bytes === undefined
    ? {}
    : { max_structure_bytes: parameters.max_structure_bytes }),
  ...(parameters.max_parser_entries === undefined
    ? {}
    : { max_parser_entries: parameters.max_parser_entries }),
  ...(parameters.max_parser_visits === undefined
    ? {}
    : { max_parser_visits: parameters.max_parser_visits }),
  ...(parameters.max_token_bytes === undefined
    ? {}
    : { max_token_bytes: parameters.max_token_bytes }),
});

/** One Evidence interpretation for success and observations retained by file finalization failures. */
export const createGpuCodeObjectsEvidence = (
  report: GpuCodeObjects,
  provider: EvidenceProvider,
  parameters: GpuCodeObjectsInput,
): Evidence =>
  createEvidence(
    {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
      format: "file",
    },
    provider,
    {
      operation: "inspect_gpu_code_objects",
      parameters: gpuParameters(parameters),
      result: report,
      confidence: "observed",
      locations: [{ kind: "artifact-path", path: report.artifact.path }],
      limitations: report.limitations,
    },
  );

export const createGpuCodeObjectsPartialEvidence = (
  report: GpuCodeObjectsPartial,
  provider: EvidenceProvider,
  parameters: GpuCodeObjectsInput,
): Evidence =>
  createEvidence(unknownTarget("not-observed"), provider, {
    operation: "inspect_gpu_code_objects",
    parameters: gpuParameters(parameters),
    result: report,
    confidence: "observed",

    locations: [{ kind: "artifact-path", path: report.artifact.path }],
    limitations: [
      "The interrupted inspection did not complete final file identity verification; root digest and completeness are unknown.",
      ...report.limitations,
    ],
  });
