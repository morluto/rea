import { describe, expect, it } from "vitest";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { RegularFileCleanupFailure } from "../../filesystem/OwnedRegularFile.js";
import { RetainedRegularFileCleanupFailure } from "../RegularFileRead.js";
import { desktopOperationFailure } from "./DesktopCaptureRefusals.js";

describe("desktopOperationFailure", () => {
  it("uses a reader cancellation origin without an ambient aborted signal", () => {
    const reason = { source: "caller", code: "EACCES" };
    const failure = desktopOperationFailure(
      new ArtifactReaderFailure("cancelled", "Stopped reading", {
        cause: reason,
      }),
      undefined,
      "inspect_desktop_application_state",
      "Desktop state view",
    );
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(failure.cause).toBe(reason);
    expect(failure.cleanupResources).toEqual([]);
  });

  it("keeps raw failure identity despite cancellation-shaped diagnostic text", () => {
    const cause = Object.assign(new Error("Physical failure"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
    const controller = new AbortController();
    const reason = { source: "later cancellation" };
    controller.abort(reason);
    const failure = desktopOperationFailure(
      cause,
      controller.signal,
      "inspect_desktop_application_state",
      "Desktop state view",
    );
    expect(failure).toBeInstanceOf(ProviderAdapterError);
    expect(failure.cause).toBe(cause);
    expect(failure.secondaryFailures).toHaveLength(1);
    expect(failure.secondaryFailures[0]).toBeInstanceOf(AnalysisCancelledError);
    expect(failure.secondaryFailures[0]?.cause).toBe(reason);
    expect(failure.cleanupResources).toEqual([]);
  });

  it("retains an input descriptor whose cleanup failed", () => {
    const path = "/tmp/desktop-download-install.json";
    const owner = { close: async () => {} };
    const failure = new RetainedRegularFileCleanupFailure(
      new RegularFileCleanupFailure({
        path,
        owner: owner as never,
        outcome: { kind: "failed", cause: new Error("read failed") },
        cleanupCause: new Error("close failed"),
      }),
    );
    const result = desktopOperationFailure(
      failure,
      undefined,
      "export_desktop_application",
      "Desktop export",
    );
    expect(result).toBeInstanceOf(ProviderAdapterError);
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.cleanupResources).toEqual([path]);
  });
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
