import type { ElectronNativeAddonBindingFinding } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  javascriptAnalysisCoverage,
  resolveArtifactPath,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import { astObservationEvidence } from "./JavaScriptArtifactGraphEvidence.js";
import { compositeKey } from "../../domain/unicodeCodePointOrder.js";
import {
  addElectronInferenceEdge,
  electronFindingSourceNode,
  electronObservationIdentity,
  electronRangeKey,
} from "./ElectronBoundaryGraphContext.js";

interface NativeBindingInput {
  readonly context: JavaScriptArtifactGraphContext;
  readonly file: JavaScriptArtifactFile;
  readonly value: ElectronNativeAddonBindingFinding;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

/** Project JavaScript-requested native addon binding and re-export surfaces. */
export const addElectronNativeBoundaries = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file, javascript } = analyzed;
    if (javascript === null) continue;
    const coverage = javascriptAnalysisCoverage(javascript);
    for (const value of javascript.electron.native_addon_bindings)
      addNativeBinding({ context, file, value, coverage });
  }
};

const addNativeBinding = (input: NativeBindingInput): void => {
  const { context, file, value, coverage } = input;
  const source = electronFindingSourceNode(context, file, value.module_key);
  if (source === undefined) return;
  const resolved = resolveArtifactPath(
    value.specifier,
    file.path,
    context.filesByPath,
    value.module_kind,
  );
  const addon = resolved === null ? undefined : context.fileNodes.get(resolved);
  const binding = context.accumulator.addNode({
    kind: "native-export",
    identity: electronObservationIdentity(
      context,
      "javascript-requested-native-export",
      // Members are a variable-length source-derived list: compositeKey keeps
      // ["a\0b"] distinct from ["a", "b"] inside the digested identity.
      `${file.path}:${value.specifier}:${value.binding_kind}:${compositeKey(value.members)}:${electronRangeKey(value.location)}`,
    ),
    observations: [
      {
        label: value.members.join(", "),
        properties: {
          specifier: value.specifier,
          binding_kind: value.binding_kind,
          requested_members: value.members,
          resolved_path: resolved,
          native_export_verification: "not-performed",
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: value.location,
          operation: "observe-native-addon-binding",
          coverage,
          limitations: [
            "JavaScript syntax identifies requested member names; it does not prove that the native binary exports or implements them.",
          ],
        }),
      },
    ],
  });
  addElectronInferenceEdge(context, {
    source,
    target: binding,
    file,
    range: value.location,
    coverage,
    relation: value.binding_kind === "re-export" ? "exposes" : "imports",
    operation: "map-native-addon-binding",
    properties: {
      specifier: value.specifier,
      binding_kind: value.binding_kind,
      requested_members: value.members,
    },
    limitations: [
      "Requested JavaScript members are not verified native exports.",
    ],
  });
  if (addon === undefined || resolved === null) return;
  addElectronInferenceEdge(context, {
    source: addon,
    target: binding,
    file,
    range: value.location,
    coverage,
    relation: "exposes",
    operation: "associate-native-addon-requested-exports",
    properties: {
      resolved_path: resolved,
      requested_members: value.members,
      verified: false,
    },
    confidence: "medium",
    limitations: [
      "The .node artifact path is resolved, but requested JavaScript members have not been verified against native symbols.",
    ],
  });
};
