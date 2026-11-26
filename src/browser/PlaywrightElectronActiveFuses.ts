import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  assertArtifactReadActive,
  ArtifactReaderFailure,
  type ArtifactResourceScope,
} from "../resources/index.js";
import { electronFuseFailure } from "../electron/ElectronFuseFailures.js";
import { basename, dirname } from "node:path";

import {
  unsupportedTarget,
  AnalysisTargetFailureError,
} from "../domain/analysisErrorCore.js";
import { resolveElectronFuseTarget } from "../electron/ElectronFusePath.js";
import { readElectronFuseImage } from "../electron/ElectronFuseReader.js";

const OPERATION = "capture_electron_scenario" as const;
const NODE_CLI_INSPECT_ARGUMENTS_FUSE_INDEX = 3;

export interface InspectArgumentsPreflightOptions {
  readonly signal?: AbortSignal;
  readonly resources?: ArtifactResourceScope;
  readonly readFuseImage?: typeof readElectronFuseImage;
}

const appBundleDirectoryOf = (executablePath: string): string | null => {
  let current = dirname(executablePath);
  while (true) {
    if (basename(current).endsWith(".app")) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

/**
 * Pre-flight verification for active Electron scenario capture.
 *
 * Playwright attaches to Electron processes using Node CLI inspect arguments
 * (--inspect=0 or --remote-debugging-port=0). When an Electron executable disables
 * the EnableNodeCliInspectArguments fuse, the runtime silently ignores inspect
 * flags and Playwright hangs until the 60-second startup deadline expires.
 *
 * When the fuse wire is present and index 3 is explicitly disabled or removed,
 * this check fast-fails with an unsupported target failure before any child
 * process is launched. When the fuse state is unknown (missing sentinel, wire
 * version != 1, or unsupported container format), launch proceeds normally.
 */
export const assertNodeCliInspectArgumentsSupported = async (
  executablePath: string,
  options?: InspectArgumentsPreflightOptions,
): Promise<void> => {
  assertArtifactReadActive(options?.signal);
  const reader = options?.readFuseImage ?? readElectronFuseImage;
  try {
    let targetPath = executablePath;
    const bundleDir = appBundleDirectoryOf(executablePath);
    if (bundleDir !== null) {
      try {
        const resolved = await resolveElectronFuseTarget(
          bundleDir,
          options?.signal,
        );
        targetPath = resolved.file.path;
      } catch (cause: unknown) {
        if (options?.signal?.aborted) throw cause;
        targetPath = executablePath;
      }
    }

    const image = await reader(targetPath, {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.resources === undefined
        ? {}
        : { resources: options.resources }),
    });
    if (image.slices.length === 0) return;

    // The fuses that matter are the ones in the slice this host launches.
    const { architecture } = HOST_PLATFORM;
    const hostArchitecture = architecture === "x64" ? "x86_64" : architecture;
    const targetSlice =
      image.slices.find((slice) => slice.architecture === hostArchitecture) ??
      image.slices[0];

    if (targetSlice === undefined) return;

    for (const sentinel of targetSlice.sentinels) {
      if (sentinel.wire_version !== 1) continue;
      const fuse = sentinel.fuses.find(
        (entry) =>
          entry.index === NODE_CLI_INSPECT_ARGUMENTS_FUSE_INDEX ||
          entry.name === "EnableNodeCliInspectArguments",
      );
      if (fuse?.state === "disabled" || fuse?.state === "removed") {
        throw unsupportedTarget(
          OPERATION,
          executablePath,
          "electron",
          "Target binary disables the EnableNodeCliInspectArguments fuse; Node CLI inspector arguments are ignored and active scenario capture cannot attach. Active capture can still run against an Electron development build or a stock Electron runtime with the extracted app.",
          {
            field: "EnableNodeCliInspectArguments",
            related: { operations: ["inspect_electron_page"] },
          },
        );
      }
    }
  } catch (cause: unknown) {
    if (cause instanceof AnalysisTargetFailureError) throw cause;
    if (
      cause instanceof ArtifactReaderFailure &&
      (cause.cleanup !== undefined || cause.reason === "cancelled")
    )
      throw electronFuseFailure(cause, executablePath, OPERATION);
    assertArtifactReadActive(options?.signal);
    // Missing sentinels, format failures, or unreadable fuses leave inspection capability unknown; proceed with launch.
  }
};
