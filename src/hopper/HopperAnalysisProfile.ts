import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type {
  AnalysisProfileResolution,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import type {
  BinaryArchitecture,
  BinaryTarget,
} from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  ProviderAdapterError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

interface HopperProfileOptions {
  readonly launcherPath: string;
  readonly loaderArgsOverride: readonly string[];
  readonly provider: ProviderIdentity;
  readonly signal?: AbortSignal;
}

/** Resolve Hopper open semantics without placing its CLI flags in BinaryTarget. */
export const resolveHopperAnalysisProfile = async (
  target: BinaryTarget,
  options: HopperProfileOptions,
): Promise<Result<AnalysisProfileResolution, AnalysisError>> => {
  if (target.kind !== "executable" && target.kind !== "database")
    return ok({ profile: null, compatibility: {} });
  const derived = hopperLoaderArgsForTarget(target);
  if (!derived.ok) return derived;
  const loaderArgs =
    options.loaderArgsOverride.length === 0
      ? derived.value
      : [...options.loaderArgsOverride];
  const compatibility = { loaderArgs: [...loaderArgs] };
  const launcherDigest = await sha256File(options.launcherPath, options.signal);
  if (!launcherDigest.ok) return launcherDigest;
  if (launcherDigest.value === undefined)
    return ok({ profile: null, compatibility });
  const provider = {
    id: options.provider.id,
    name: options.provider.name,
    version: `launcher-sha256:${launcherDigest.value}`,
  };
  return ok({
    profile: createAnalysisProfile(provider, 1, {
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
      available_architectures: [
        ...(target.availableArchitectures ?? []),
      ].sort(),
      loader: {
        source:
          options.loaderArgsOverride.length === 0
            ? "derived"
            : "configured_override",
        argument_count: loaderArgs.length,
        arguments_sha256: createHash("sha256")
          .update(JSON.stringify(loaderArgs))
          .digest("hex"),
      },
    }),
    compatibility,
  });
};

/** Derive Hopper's complete non-interactive CLI loader selection. */
export const hopperLoaderArgsForTarget = (
  target: BinaryTarget,
): Result<readonly string[], ProviderAdapterError> => {
  if (target.kind === "database") return ok([]);
  const architecture = target.architecture;
  if (architecture === undefined)
    return err(new ProviderAdapterError("hopper", "resolve_analysis_profile"));
  const flag = hopperArchitectureFlag(architecture);
  switch (target.format) {
    case "mach-o":
      return ok(
        (target.availableArchitectures?.length ?? 0) > 1
          ? ["-l", "FAT", flag, "-l", "Mach-O"]
          : ["-l", "Mach-O", flag],
      );
    case "elf":
      return ok(["-l", "ELF", flag]);
    case "pe":
      return ok(["-l", "WinPE", flag]);
    default:
      return err(
        new ProviderAdapterError("hopper", "resolve_analysis_profile"),
      );
  }
};

const hopperArchitectureFlag = (architecture: BinaryArchitecture): string => {
  switch (architecture) {
    case "x86":
      return "--intel-32";
    case "x86_64":
      return "--intel-64";
    case "arm":
      return "--armv7";
    case "arm64":
      return "--aarch64";
  }
};

const sha256File = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<Result<string | undefined, AnalysisCancelledError>> => {
  if (signalIsAborted(signal))
    return err(new AnalysisCancelledError("open_binary"));
  const stream = createReadStream(path);
  const onAbort = (): void => {
    stream.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const hash = createHash("sha256");
    for await (const chunk of stream) hash.update(chunk);
    return signalIsAborted(signal)
      ? err(new AnalysisCancelledError("open_binary"))
      : ok(hash.digest("hex"));
  } catch {
    return signalIsAborted(signal)
      ? err(new AnalysisCancelledError("open_binary"))
      : ok(undefined);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;
