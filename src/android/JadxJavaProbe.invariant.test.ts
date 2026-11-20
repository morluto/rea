import { expect, it, vi } from "vitest";

import { InternalInvariantError } from "../domain/internalInvariant.js";
import { inspectJadxJava } from "./JadxJavaProbe.js";
import { createInspectionResources } from "../../tests/fixtures/inspectionResources.js";

/**
 * runOwnedCommand observes every completed run before it resolves, so a run
 * that resolves unobserved is replaced here to reach the probe's invariant.
 */
vi.mock("../process/OwnedCommand.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/OwnedCommand.js")>()),
  prepareOwnedCommand: async () => undefined,
  runOwnedCommand: async () => undefined,
}));

it("reports an unobserved completed Java probe as a REA defect, not a Java refusal", async () => {
  const resources = createInspectionResources();
  try {
    const rejected: unknown = await inspectJadxJava(
      "/selected/java",
      {},
      { resourceOwner: resources.owner },
    ).catch((cause: unknown) => cause);

    expect(rejected).toMatchObject({ _tag: "ProviderAdapterError" });
    expect((rejected as Error).cause).toBeInstanceOf(InternalInvariantError);
  } finally {
    await resources.close();
  }
});
