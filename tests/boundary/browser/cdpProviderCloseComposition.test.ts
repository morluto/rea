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

const closeFailure = async (close: () => Promise<void>): Promise<unknown> => {
  try {
    await close();
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("Expected close to fail");
};

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

it.each(providers)(
  "$name keeps both close failures and completes only after both release",
  async ({ providerId, operation, create, failSecondClose }) => {
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const transport = cleanupFailure("transport-handle");
    const second = cleanupFailure("second-handle");
    vi.spyOn(CdpTargetSessionOwner.prototype, "close").mockRejectedValueOnce(
      transport,
    );
    failSecondClose(second);
    const provider = create();

    const composite = await closeFailure(() => provider.close());

    if (!(composite instanceof ProviderCleanupError))
      throw new Error("Expected a provider cleanup failure");
    expect(composite).toMatchObject({
      providerId,
      operation,
      cleanupIncomplete: true,
      cleanupResources: ["transport-handle", "second-handle"],
    });
    expect(composite.cause).toBeInstanceOf(AggregateError);
    expect((composite.cause as AggregateError).errors).toEqual([
      transport,
      second,
    ]);

    releaseOwnedCleanup(transport);
    expect(composite.cleanupIncomplete).toBe(true);
    releaseOwnedCleanup(second);
    expect(composite.cleanupIncomplete).toBe(false);
  },
);

it.each(providers)(
  "$name keeps an untyped close failure in the cause without owning its completion",
  async ({ create, failSecondClose }) => {
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const transport = cleanupFailure("transport-handle");
    const untyped = new Error("untyped close failure");
    vi.spyOn(CdpTargetSessionOwner.prototype, "close").mockRejectedValueOnce(
      transport,
    );
    failSecondClose(untyped);
    const provider = create();

    const composite = await closeFailure(() => provider.close());

    if (!(composite instanceof ProviderCleanupError))
      throw new Error("Expected a provider cleanup failure");
    expect(composite.cleanupResources).toEqual(["transport-handle"]);
    expect((composite.cause as AggregateError).errors).toEqual([
      transport,
      untyped,
    ]);
    expect(composite.cleanupIncomplete).toBe(true);
    releaseOwnedCleanup(transport);
    expect(composite.cleanupIncomplete).toBe(false);
  },
);
