import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type {
  AnalysisProfileResolution,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";

import {
  resolveHopperMachOImage,
  type HopperMachOImage,
} from "./HopperMachOImage.js";

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
    return ok({ profile: null });
  let machoContainer: "thin" | "fat32" | "fat64" | undefined;
  if (target.kind === "executable" && target.format === "mach-o") {
    const header = await readMachoMagic(target.path, options.signal);
    if (!header.ok) return header;
    machoContainer = [0xcafebabf, 0xbfbafeca].includes(header.value)
      ? "fat64"
      : [0xcafebabe, 0xbebafeca].includes(header.value)
        ? "fat32"
        : "thin";
  }
  let preparedImage: HopperMachOImage | undefined;
  if (
    target.kind === "executable" &&
    machoContainer === "fat64" &&
    options.loaderArgsOverride.length === 0
  ) {
    const resolved = await resolveHopperMachOImage(target, options.signal);
    if (!resolved.ok) return resolved;
    preparedImage = resolved.value;
  }
  const derived = hopperLoaderArgsForTarget(
    target,
    preparedImage === undefined ? machoContainer : "thin",
  );
  if (!derived.ok) return derived;
  const loaderArgs =
    options.loaderArgsOverride.length === 0
      ? derived.value
      : [...options.loaderArgsOverride];
  const launcherDigest = await sha256File(options.launcherPath, options.signal);
  if (!launcherDigest.ok) return launcherDigest;
  if (launcherDigest.value === undefined) return ok({ profile: null });
  const provider = {
    id: options.provider.id,
    name: options.provider.name,
    version: `launcher-sha256:${launcherDigest.value}`,
  };
  return ok({
    profile: createAnalysisProfile(provider, {
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
      available_architectures: [
        ...(target.availableArchitectures ?? []),
      ].sort(),
      ...(machoContainer === undefined
        ? {}
        : { macho_container: machoContainer }),
      ...(preparedImage === undefined
        ? {}
        : { prepared_image: { ...preparedImage } }),
      loader: {
        source:
          options.loaderArgsOverride.length === 0
            ? "derived"
            : "configured_override",
        arguments: [...loaderArgs],
      },
    }),
  });
};

/** Derive Hopper's complete non-interactive CLI loader selection. */
export const hopperLoaderArgsForTarget = (
  target: BinaryTarget,
  machoContainer?: "thin" | "fat32" | "fat64",
): Result<
  readonly string[],
  ProviderAdapterError | AnalysisCapabilityUnavailableError
> => {
  if (target.kind === "database") return ok([]);
  if (target.kind !== "executable")
    return err(new ProviderAdapterError("hopper", "resolve_analysis_profile"));
  const architecture = target.architecture;
  if (architecture === "mips")
    return err(
      new AnalysisCapabilityUnavailableError(
        "hopper",
        "resolve_analysis_profile",
        "REA's Hopper adapter does not admit MIPS targets. Select a verified Ghidra MIPS profile instead.",
      ),
    );
  const flag = hopperArchitectureFlag(architecture);
  switch (target.format) {
    case "mach-o":
      if (machoContainer === undefined)
        return err(
          new AnalysisCapabilityUnavailableError(
            "hopper",
            "resolve_analysis_profile",
            "Mach-O container kind is unknown; resolve the Hopper analysis profile before starting its client.",
          ),
        );
      return ok(
        machoContainer === "fat32" || machoContainer === "fat64"
          ? ["-l", "FAT", flag, "-l", "Mach-O"]
          : ["-l", "Mach-O", flag],
      );
    case "elf":
      return ok(["-l", "ELF", flag]);
    case "pe":
      return ok(["-l", "WinPE", flag]);
    case "dos-mz":
    case "dos-com":
      return err(
        new ProviderAdapterError("hopper", "resolve_analysis_profile"),
      );
  }
};

const hopperArchitectureFlag = (
  architecture: Exclude<BinaryArchitecture, "mips">,
): string => {
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

const readMachoMagic = async (
  path: string,
  signal?: AbortSignal,
): Promise<Result<number, AnalysisError>> => {
  if (signalIsAborted(signal))
    return err(new AnalysisCancelledError("open_binary"));
  const stream = createReadStream(path, { start: 0, end: 3 });
  const onAbort = (): void => {
    stream.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    if (signalIsAborted(signal))
      return err(new AnalysisCancelledError("open_binary"));
    const bytes = Buffer.concat(chunks);
    return bytes.length === 4
      ? ok(bytes.readUInt32BE(0))
      : err(
          new BinaryTargetError(
            path,
            "Mach-O header became truncated before Hopper loader selection",
          ),
        );
  } catch (cause: unknown) {
    return signalIsAborted(signal)
      ? err(new AnalysisCancelledError("open_binary"))
      : err(
          new BinaryTargetError(
            path,
            `Cannot read the Mach-O container header: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          ),
        );
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
  } catch (cause: unknown) {
    // best-effort cleanup: unreadable targets mean no digest; abort still cancels.
    void cause;
    return signalIsAborted(signal)
      ? err(new AnalysisCancelledError("open_binary"))
      : ok(undefined);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;
