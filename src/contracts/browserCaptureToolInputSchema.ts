import { browserCaptureComparisonInputSchema } from "../domain/browserCaptureComparison.js";
import { browserScenarioCaptureSchema } from "../domain/browserScenarioCapture.js";
import { captureSnapshotSchema } from "../domain/webCaptureDiffSchemas.js";

// Captures are complete producer results to pass back unchanged, rather than
// analyst-authored options. Describe that boundary without embedding the entire
// inspection result schema in every comparison input. The cloned parser still
// validates every nested field using the canonical domain schemas.
const passiveCaptureInputSchema = captureSnapshotSchema.clone(
  captureSnapshotSchema.def,
);
passiveCaptureInputSchema._zod.toJSONSchema = () => ({
  type: "object",
  properties: {
    inspection: {
      type: "object",
      description:
        "Complete result object returned by inspect_web_page. Pass the entire result unchanged, including capture identity, observations, completeness, and limitations. Every nested field is validated by REA.",
    },
    webmcp: {
      anyOf: [{ type: "object" }, { type: "null" }],
      default: null,
      description:
        "Complete result object returned by discover_webmcp_tools for this capture, or null when it was not recorded. Pass the entire result unchanged. Every nested field is validated by REA.",
    },
  },
  required: ["inspection"],
});

const scenarioCaptureInputSchema = browserScenarioCaptureSchema.clone(
  browserScenarioCaptureSchema.def,
);
scenarioCaptureInputSchema._zod.toJSONSchema = () => ({
  type: "object",
  description:
    "Complete result object returned by capture_browser_scenario. Pass the entire result unchanged, including browser and scenario identity, steps, events, artifact contents and digests, completeness, and limitations. Every nested field is validated by REA.",
});

/** Advertise capture round trips while retaining full runtime validation. */
export const browserCaptureToolInputSchema =
  browserCaptureComparisonInputSchema.safeExtend({
    before: passiveCaptureInputSchema
      .optional()
      .describe(
        "Earlier passive web-page capture with complete producer results.",
      ),
    after: passiveCaptureInputSchema
      .optional()
      .describe(
        "Later passive web-page capture with complete producer results.",
      ),
    before_scenario: scenarioCaptureInputSchema
      .optional()
      .describe(
        "Earlier complete result object returned by capture_browser_scenario.",
      ),
    after_scenario: scenarioCaptureInputSchema
      .optional()
      .describe(
        "Later complete result object returned by capture_browser_scenario.",
      ),
  });
