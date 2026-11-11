import { expect, it, vi } from "vitest";

import { ArtifactProvider } from "./ArtifactProvider.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
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
      throw new ArtifactReaderFailure("format", "controlled decode refusal");
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
