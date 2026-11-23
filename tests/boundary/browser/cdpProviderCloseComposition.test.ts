import { expect, it, onTestFinished, vi } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { CdpTargetSessionOwner } from "../../../src/browser/CdpTargetSessionOwner.js";
import { ElectronFileScope } from "../../../src/browser/ElectronFileScope.js";
import { IsolatedWebBundleAnalyzer } from "../../../src/browser/IsolatedWebBundleAnalyzer.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { releaseOwnedCleanup } from "../../support/cleanupRelease.js";

const cleanupFailure = (resource: string) =>
  new ProviderCleanupError(
    "fixture",
    [resource],
    { reason: `${resource} remains owned` },
    { operation: "fixture_close" },
  );

const providers = [
  {
    name: "CdpBrowserProvider",
    providerId: "rea-cdp-browser",
    operation: "analyze_web_bundle",
    create: () => new CdpBrowserProvider(),
    failSecondClose: (cause: unknown) =>
      vi
        .spyOn(IsolatedWebBundleAnalyzer.prototype, "close")
        .mockRejectedValueOnce(cause),
  },
  {
    name: "CdpElectronProvider",
    providerId: "rea-cdp-electron",
    operation: "inspect_electron_page",
    create: () => new CdpElectronProvider(),
    failSecondClose: (cause: unknown) =>
      vi
        .spyOn(ElectronFileScope.prototype, "retryCleanup")
        .mockRejectedValueOnce(cause),
  },
] as const;

it.each(
  providers.flatMap((provider) =>
    (["owned", "untyped"] as const).map((secondary) => ({
      ...provider,
      secondary,
    })),
  ),
)(
  "$name reports both close failures with an $secondary secondary cause",
  async ({ providerId, operation, create, failSecondClose, secondary }) => {
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const transport = cleanupFailure("transport-handle");
    const second =
      secondary === "owned"
        ? cleanupFailure("second-handle")
        : new Error("untyped close failure");
    vi.spyOn(CdpTargetSessionOwner.prototype, "close").mockRejectedValueOnce(
      transport,
    );
    failSecondClose(second);
    const provider = create();

    const composite = await provider.close().catch((cause: unknown) => cause);

    if (!(composite instanceof ProviderCleanupError))
      throw new Error("Expected a provider cleanup failure");
    expect(composite).toMatchObject({
      providerId,
      operation,
      cleanupIncomplete: true,
      cleanupResources:
        secondary === "owned"
          ? ["transport-handle", "second-handle"]
          : ["transport-handle"],
    });
    expect(composite.cause).toBeInstanceOf(AggregateError);
    expect((composite.cause as AggregateError).errors).toEqual([
      transport,
      second,
    ]);

    releaseOwnedCleanup(transport);
    if (second instanceof ProviderCleanupError) {
      expect(composite.cleanupIncomplete).toBe(true);
      releaseOwnedCleanup(second);
    }
    expect(composite.cleanupIncomplete).toBe(false);
  },
);
