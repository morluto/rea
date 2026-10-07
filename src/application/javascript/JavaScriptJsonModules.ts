import { compareCodePoints } from "../../domain/canonicalOrdering.js";
import type { JavaScriptJsonModuleObservation } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";

/** Parse one approved JSON module without evaluating JavaScript or resolving imports. */
export const analyzeJavaScriptJsonModule = (
  file: JavaScriptArtifactFile,
): JavaScriptJsonModuleObservation => {
  if (!file.text.included)
    return {
      path: file.path,
      sha256: file.sha256,
      status: "unavailable",
      top_level_keys: [],
      omitted_top_level_keys: null,
      limitation: `JSON module text was unavailable: ${file.text.reason}.`,
    };
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch (cause: unknown) {
    void cause;
    return {
      path: file.path,
      sha256: file.sha256,
      status: "invalid",
      top_level_keys: [],
      omitted_top_level_keys: 0,
      limitation: "JSON module is not valid JSON.",
    };
  }
  const keys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value).sort(compareCodePoints)
      : [];
  const retained = keys;
  return {
    path: file.path,
    sha256: file.sha256,
    status: "included",
    top_level_keys: retained,
    omitted_top_level_keys: 0,
    limitation: null,
  };
};
