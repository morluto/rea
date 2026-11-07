import { createJavaScriptRuntimeObservationEvidence } from "../../src/application/javascript/JavaScriptRuntimeObservationEvidence.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../src/contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { javascriptRuntimeObservationSchema } from "../../src/domain/javascript/javascriptRuntimeObservation.js";
import { V8_INSPECTOR_PROVIDER_IDENTITY } from "../../src/inspector/providerIdentity.js";

/** Synthetic, schema-validated capture; this is not a live Inspector observation. */
export const nodeReconciliationFixture = (scriptObserved: boolean) => {
  const location = {
    kind: "file",
    file_path: "/Applications/Example.app/Contents/Resources/app/renderer.js",
  };
  const runtime = javascriptRuntimeObservationSchema.parse({
    runtime: {
      product: "node.js/v24.22.1",
      protocol_version: "1.3",
      v8_version: null,
    },
    target: {
      target_id: "synthetic-node",
      protocol_type: "node",
      attached: null,
      location,
      runtime_kind: "unknown",
      runtime_kind_authority: "not-declared",
    },
    capture: {
      observation_ms: 100,
      events_observed: scriptObserved ? 1 : 0,
      events_retained: scriptObserved ? 1 : 0,
      events_dropped: 0,
      metadata_bytes_retained: 0,
      truncated: false,
      truncation_reasons: [],
    },
    scripts: {
      items: scriptObserved
        ? [
            {
              script_key: `v8_script_${"4".repeat(64)}`,
              location,
              execution_context_key: null,
              cdp_hash: null,
              length: null,
              is_module: null,
              status: "observed-loaded",
            },
          ]
        : [],
      observed_total: scriptObserved ? 1 : 0,
      excluded: { unsupported_location: 0, invalid_protocol_value: 0 },
    },
    execution_contexts: [],
    directly_observed: [],
    unavailable_without_instrumentation: [],
    unknowns: ["Synthetic bounded capture."],
    limitations: ["Synthetic fixture, not a live runtime."],
  });
  return {
    static_layers: [{ analysis: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE }],
    runtime_observations: [
      createJavaScriptRuntimeObservationEvidence(
        "observe_javascript_runtime",
        {
          inspector_endpoint: "http://127.0.0.1:9229",
          target_id: "synthetic-node",
          observation_ms: 100,
        },
        runtime,
        V8_INSPECTOR_PROVIDER_IDENTITY,
      ),
    ],
  };
};
