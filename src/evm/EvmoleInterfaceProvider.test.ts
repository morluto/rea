import { access } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { EvmoleInterfaceProvider } from "./EvmoleInterfaceProvider.js";
import { EvmInterfaceService } from "../application/evm/EvmInterfaceService.js";

const input = { path: "/not-read.hex", encoding: "hex" as const };

it.each(["provider", "service"] as const)(
  "refuses queued and new EVM work through %s during shutdown without inventing cleanup failure",
  async (boundary) => {
    const provider = new EvmoleInterfaceProvider({});
    const service = new EvmInterfaceService(provider);
    const inspect = () =>
      boundary === "service" ? service.inspect(input) : provider.inspect(input);
    const queued = inspect();
    const closing = provider.close();
    const duringClose = inspect();
    await closing;
    for (const result of [await queued, await duringClose, await inspect()]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected shutdown refusal");
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(result.error.cleanupResources).toEqual([]);
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "capability_unavailable",
      });
    }
  },
);

it("retains a real cleanup owner through failed EVM close and releases it on retry", async () => {
  const provider = new EvmoleInterfaceProvider({});
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-evm-close-boundary-",
  });
  let denied = true;
  const original = ArtifactResourceScope.prototype.close;
  const spy = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementationOnce(function (this: ArtifactResourceScope) {
      this.retain({
        kind: "private-runtime-root",
        resource: root.path,
        root: {
          path: root.path,
          close: async () => {
            if (denied) throw new Error("controlled root close failure");
            await root.close();
          },
        },
      });
      return original.call(this);
    });
  try {
    const failure: unknown = await provider
      .close()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisError);
    if (!(failure instanceof AnalysisError)) throw failure;
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toContain(root.path);
    await access(root.path);
    denied = false;
    await provider.close();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    spy.mockRestore();
    denied = false;
    await provider.close();
    await root.close();
  }
});
