import {
  createEvidence,
  type Evidence,
  type EvidenceProvider,
} from "../evidence.js";
import type {
  InspectOciImageLayoutInput,
  OciImageLayout,
} from "./imageLayout.js";

export const INSPECT_OCI_IMAGE_LAYOUT_OPERATION = "inspect_oci_image_layout";

/** One Evidence shape for completed and cleanup-recovered OCI inventories. */
export const createOciImageLayoutEvidence = (
  provider: EvidenceProvider,
  parameters: Partial<InspectOciImageLayoutInput>,
  report: OciImageLayout,
): Evidence =>
  createEvidence(
    {
      path: report.artifact.path,
      format: "directory",
      sha256: report.artifact.snapshot_sha256,
    },
    provider,
    {
      operation: INSPECT_OCI_IMAGE_LAYOUT_OPERATION,
      parameters,
      result: report,
      confidence: "observed",
      limitations: report.limitations,
      locations: [{ kind: "artifact-path", path: report.artifact.path }],
    },
  );
