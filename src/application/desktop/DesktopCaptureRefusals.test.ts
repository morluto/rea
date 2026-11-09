import { describe, expect, it } from "vitest";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { desktopOperationFailure } from "./DesktopCaptureRefusals.js";

describe("desktopOperationFailure", () => {
  it("keeps reporting a resource that could not be released", async () => {
    const resources = new ArtifactResourceScope();
    const removed = await resources.release({
      kind: "lease",
      resource: "/tmp/rea-desktop-state-staged",
      lease: { release: () => Promise.reject(new Error("busy")) },
    });
    if (removed.kind !== "failed") throw new Error("expected a failed release");

    const failure = desktopOperationFailure(
      resources.cleanupFailure({ kind: "completed" }, [removed]),
      undefined,
      "inspect_desktop_application_state",
      "The state view",
    );

    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(failure.cleanupResources).toEqual(["/tmp/rea-desktop-state-staged"]);
  });
});
