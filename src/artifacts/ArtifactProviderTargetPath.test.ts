import { expect, it, vi } from "vitest";

import { ArtifactProvider } from "./ArtifactProvider.js";
import { malformedArtifact } from "../resources/ArtifactReader.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import * as interfaceBuilder from "./apple/InterfaceBuilderAnalysis.js";

it("names the bundle the caller selected, not its resolved target, in a target failure", async () => {
  const inspect = vi
    .spyOn(interfaceBuilder, "analyzeInterfaceBuilderBundle")
    .mockRejectedValue(malformedArtifact("nib-archive", "controlled refusal"));
  const client = new ArtifactProvider({}, "darwin").createBundleResourceClient({
    callerPath: "/fixture/Selected.app",
    canonicalPath: "/fixture/Actual.app",
    infoPlistPath: "/fixture/Actual.app/Info.plist",
    layout: "root",
    executableSha256: null,
  });
  try {
    const result = await client.execute("decode_interface_builder", {});
    if (result.ok) throw new Error("Expected a target failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "unsupported_target",
      details: {
        path: "/fixture/Selected.app",
        failure_kind: "malformed",
        format: "nib-archive",
      },
    });
  } finally {
    inspect.mockRestore();
    await client.close();
  }
});
