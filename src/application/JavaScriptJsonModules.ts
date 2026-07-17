import type { JavaScriptJsonModuleObservation } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";

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
  } catch {
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
  const retained = keys.slice(0, 128);
  return {
    path: file.path,
    sha256: file.sha256,
    status: "included",
    top_level_keys: retained,
    omitted_top_level_keys: keys.length - retained.length,
    limitation: null,
  };
};

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
