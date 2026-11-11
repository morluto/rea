import { createEvidence } from "../../domain/evidence.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "./javascriptRuntimeReconciliationExample.js";

/** Portable source records demonstrate admission, without claiming a real capture. */
export const STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE = {
  application: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
  capture: createEvidence(
    undefined,
    { id: "rea-example-har", name: "Example HAR", version: "1" },
    {
      operation: "inspect_web_network_capture",
      parameters: { sensitive_value_count: 0 },
      result: {
        artifact: { path: "/capture.har", sha256: null, bytes: 0 },
        format: "har",
        decoder: { id: "rea-example-har", name: "Example HAR", version: "1" },
        container: {
          reported: {},
          numeric_literals: [],
          redactions: [],
          records_pointer: "/log/entries",
        },
        total_records: 0,
        records: [],
        runtime_attribution: "unknown",
        limitations: ["Empty illustrative capture, not a runtime measurement."],
      },
      confidence: "observed",
    },
  ),
  origin: "https://example.test",
};
