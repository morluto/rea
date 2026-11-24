import { expect, it, vi } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ArtifactProvider } from "./ArtifactProvider.js";
import { malformedArtifact } from "../resources/ArtifactReader.js";
import * as interfaceBuilder from "./apple/InterfaceBuilderAnalysis.js";

it("updates a bundle resource client's returned cleanup error after close retry", async () => {
  let denied = true;
  const closeCause = new Error("controlled resource close failure");
  const inspect = vi
    .spyOn(interfaceBuilder, "analyzeInterfaceBuilderBundle")
    .mockImplementation(async ({ resources }) => {
      if (resources === undefined) throw new Error("Expected resource owner");
      resources.retain({
        kind: "lease",
        resource: "selected bundle resource",
        lease: {
          async release() {
            if (denied) throw closeCause;
          },
        },
      });
      throw malformedArtifact("nib-archive", "controlled decode refusal");
    });
  const client = new ArtifactProvider({}, "darwin").createBundleResourceClient({
    callerPath: "/fixture/Demo.app",
    canonicalPath: "/fixture/Demo.app",
    infoPlistPath: "/fixture/Demo.app/Info.plist",
    layout: "root",
    executableSha256: null,
  });
  try {
    expect((await client.execute("decode_interface_builder", {})).ok).toBe(
      false,
    );
    const closed = await client.close();
    if (closed.ok) throw new Error("Expected retained resource cleanup");
    const failure = closed.error;
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toEqual(["selected bundle resource"]);
    const cause = failure.cause;
    denied = false;
    expect((await client.close()).ok).toBe(true);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
    expect(failure.cause).toBe(cause);
  } finally {
    denied = false;
    await client.close();
    inspect.mockRestore();
  }
});

it("preserves the caller-selected bundle path on target refusals when canonicalPath differs", async () => {
  const inspect = vi
    .spyOn(interfaceBuilder, "analyzeInterfaceBuilderBundle")
    .mockRejectedValueOnce(
      malformedArtifact("nib-archive", "corrupt keyed archive"),
    );
  const client = new ArtifactProvider({}, "darwin").createBundleResourceClient({
    callerPath: "/fixture/Selected.app",
    canonicalPath: "/fixture/Actual.app",
    infoPlistPath: "/fixture/Actual.app/Info.plist",
    layout: "root",
    executableSha256: null,
  });
  try {
    const outcome = await client.execute("decode_interface_builder", {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Expected bundle decode refusal");
    expect(projectAnalysisError(outcome.error)).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "decode_interface_builder",
        path: "/fixture/Selected.app",
        failure_kind: "malformed",
        format: "nib-archive",
      },
    });
  } finally {
    await client.close();
    inspect.mockRestore();
  }
});
