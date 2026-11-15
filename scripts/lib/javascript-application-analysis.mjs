import { analyzeJavaScriptApplication } from "../../dist/application/javascript/JavaScriptApplicationService.js";
import { withVerifierArtifactScope } from "./verifier-artifact-scope.mjs";

/** Analyze one JavaScript application and close its caller-owned resources. */
export const analyzeJavaScriptApplicationWithOwnedScope = (input) =>
  withVerifierArtifactScope(async (scope) => {
    const result = await analyzeJavaScriptApplication(input, scope);
    if (!result.ok) throw result.error;
    return result.value;
  });
