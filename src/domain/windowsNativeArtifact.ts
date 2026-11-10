import { observeMzWindowsHeader } from "./dosMz.js";
import { createHash } from "node:crypto";
import { readPeCoffHeader } from "./peCoffHeader.js";
import { readPeOptionalHeaderIdentity } from "./peOptionalHeader.js";
import { err, ok, type Result } from "./result.js";

/** Fixed compatibility contract shared by the artifact producer and readers. */
export const WINDOWS_NATIVE_ARTIFACT = {
  platform: "win32",
  architecture: "x64",
  abiVersion: 1,
  nodeApiVersion: 8,
  artifact: "rea-windows-x64.node",
} as const;

/** Node header release pinned by the Windows native build and source verifier. */
export const WINDOWS_NATIVE_NODE_VERSION = "22.19.0";

/** Native C++ inputs whose digest binds built artifacts to current sources. */
export const WINDOWS_NATIVE_SOURCE_FILES = [
  "native/windows/src/addon.cc",
  "native/windows/src/authority.hpp",
  "native/windows/src/filesystem.cc",
  "native/windows/src/handle_close.hpp",
  "native/windows/src/process.cc",
] as const;

/** Native C++ inputs used when building the controlled inspection-failure fixture. */
export const WINDOWS_NATIVE_INSPECTION_FIXTURE_SOURCE_FILES = [
  "native/windows/src/addon.cc",
  "native/windows/src/authority.hpp",
  "tests/fixtures/windows-native-inspection-failure.cc",
  "native/windows/src/handle_close.hpp",
  "native/windows/src/process.cc",
] as const;

/** Packaged artifact and PE machine for each admitted Windows architecture. */
export const WINDOWS_NATIVE_TARGETS = {
  x64: { artifact: "rea-windows-x64.node", machine: 0x8664 },
  arm64: { artifact: "rea-windows-arm64.node", machine: 0xaa64 },
} as const;
export type WindowsNativeArchitecture = keyof typeof WINDOWS_NATIVE_TARGETS;

export type WindowsNativeArtifactEntry<
  A extends WindowsNativeArchitecture = WindowsNativeArchitecture,
> = {
  readonly artifact: (typeof WINDOWS_NATIVE_TARGETS)[A]["artifact"];
  readonly artifactSha256: string;
};

export type WindowsNativeArtifactsMap = {
  readonly [A in WindowsNativeArchitecture]?: WindowsNativeArtifactEntry<A>;
};

const windowsNativeArtifactFor = (architecture: WindowsNativeArchitecture) =>
  ({
    ...WINDOWS_NATIVE_ARTIFACT,
    architecture,
    artifact: WINDOWS_NATIVE_TARGETS[architecture].artifact,
  }) as const;

export type WindowsNativeManifest = ReturnType<
  typeof windowsNativeArtifactFor
> & {
  readonly packageVersion: string;
  readonly artifactSha256: string;
  readonly sourceSha256?: string;
  readonly artifacts?: WindowsNativeArtifactsMap;
};

export class WindowsNativeArtifactError extends Error {
  readonly _tag = "WindowsNativeArtifactError" as const;
}

const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const isWindowsNativeArchitecture = (
  value: unknown,
): value is WindowsNativeArchitecture =>
  typeof value === "string" && Object.hasOwn(WINDOWS_NATIVE_TARGETS, value);

/** Compute the source digest over pinned Node headers and native C++ inputs. */
export const computeWindowsNativeSourceSha256 = (
  sources: Readonly<Record<string, Uint8Array>>,
  options: {
    readonly nodeVersion?: string;
    readonly inspectionFixture?: boolean;
  } = {},
): Result<string, WindowsNativeArtifactError> => {
  const nodeVersion = options.nodeVersion ?? WINDOWS_NATIVE_NODE_VERSION;
  const inspectionFixture = options.inspectionFixture === true;
  const paths = inspectionFixture
    ? WINDOWS_NATIVE_INSPECTION_FIXTURE_SOURCE_FILES
    : WINDOWS_NATIVE_SOURCE_FILES;
  const hash = createHash("sha256")
    .update(`node:${nodeVersion}\n`)
    .update(`fixture:${String(inspectionFixture)}\n`);
  for (const path of paths) {
    const bytes = sources[path];
    if (bytes === undefined)
      return err(
        new WindowsNativeArtifactError(
          `Missing Windows native build source input ${path}`,
        ),
      );
    hash.update(`${path.length}:${path}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return ok(hash.digest("hex"));
};

const parseWindowsNativeArtifactsMap = (
  value: unknown,
): Result<WindowsNativeArtifactsMap, WindowsNativeArtifactError> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid artifacts",
      ),
    );
  const raw = value as Record<string, unknown>;
  const parsed: {
    x64?: WindowsNativeArtifactEntry<"x64">;
    arm64?: WindowsNativeArtifactEntry<"arm64">;
  } = {};
  for (const key of Object.keys(raw)) {
    if (!isWindowsNativeArchitecture(key))
      return err(
        new WindowsNativeArtifactError(
          "Windows native artifact manifest has missing or unknown fields",
        ),
      );
    const entry = raw[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return err(
        new WindowsNativeArtifactError(
          "Windows native artifact manifest has an invalid artifacts",
        ),
      );
    const entryRecord = entry as Record<string, unknown>;
    const entryKeys = ["artifact", "artifactSha256"];
    if (
      Object.keys(entryRecord).length !== entryKeys.length ||
      entryKeys.some((entryKey) => !Object.hasOwn(entryRecord, entryKey))
    )
      return err(
        new WindowsNativeArtifactError(
          "Windows native artifact manifest has missing or unknown fields",
        ),
      );
    const expectedArtifact =
      key === "x64"
        ? WINDOWS_NATIVE_TARGETS.x64.artifact
        : WINDOWS_NATIVE_TARGETS.arm64.artifact;
    if (entryRecord.artifact !== expectedArtifact)
      return err(
        new WindowsNativeArtifactError(
          "Windows native artifact manifest has an invalid artifact",
        ),
      );
    if (!isSha256Hex(entryRecord.artifactSha256))
      return err(
        new WindowsNativeArtifactError(
          "Windows native artifact manifest has an invalid artifactSha256",
        ),
      );
    if (key === "x64")
      parsed.x64 = {
        artifact: WINDOWS_NATIVE_TARGETS.x64.artifact,
        artifactSha256: entryRecord.artifactSha256,
      };
    else
      parsed.arm64 = {
        artifact: WINDOWS_NATIVE_TARGETS.arm64.artifact,
        artifactSha256: entryRecord.artifactSha256,
      };
  }
  return ok(parsed);
};

/** Parse the exact package manifest before acquiring or loading its artifact. */
export const parseWindowsNativeManifest = (
  value: unknown,
  packageVersion: string,
  architecture?: WindowsNativeArchitecture,
): Result<WindowsNativeManifest, WindowsNativeArtifactError> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest must be an object",
      ),
    );
  const manifest = value as Record<string, unknown>;
  const requiredKeys = [
    "packageVersion",
    ...Object.keys(WINDOWS_NATIVE_ARTIFACT),
    "artifactSha256",
  ];
  const allowedKeys = new Set([...requiredKeys, "sourceSha256", "artifacts"]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(manifest, key)) ||
    Object.keys(manifest).some((key) => !allowedKeys.has(key))
  )
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has missing or unknown fields",
      ),
    );
  for (const key of ["platform", "abiVersion", "nodeApiVersion"] as const)
    if (manifest[key] !== WINDOWS_NATIVE_ARTIFACT[key])
      return err(
        new WindowsNativeArtifactError(
          `Windows native artifact manifest has an invalid ${key}`,
        ),
      );
  if (!isWindowsNativeArchitecture(manifest.architecture))
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid architecture",
      ),
    );
  const topLevelArch = manifest.architecture;
  const topLevelContract = windowsNativeArtifactFor(topLevelArch);
  if (manifest.artifact !== topLevelContract.artifact)
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid artifact",
      ),
    );
  if (typeof manifest.packageVersion !== "string")
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid packageVersion",
      ),
    );
  if (!isSha256Hex(manifest.artifactSha256))
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid artifactSha256",
      ),
    );
  let sourceSha256: string | undefined;
  if (Object.hasOwn(manifest, "sourceSha256")) {
    if (!isSha256Hex(manifest.sourceSha256))
      return err(
        new WindowsNativeArtifactError(
          "Windows native artifact manifest has an invalid sourceSha256",
        ),
      );
    sourceSha256 = manifest.sourceSha256;
  }
  let artifacts: WindowsNativeArtifactsMap | undefined;
  if (Object.hasOwn(manifest, "artifacts")) {
    const parsedArtifacts = parseWindowsNativeArtifactsMap(manifest.artifacts);
    if (!parsedArtifacts.ok) return parsedArtifacts;
    const primary = parsedArtifacts.value[topLevelArch];
    if (
      primary === undefined ||
      primary.artifact !== manifest.artifact ||
      primary.artifactSha256 !== manifest.artifactSha256
    )
      return err(
        new WindowsNativeArtifactError(
          "Windows native manifest artifacts table does not match top-level metadata",
        ),
      );
    artifacts = parsedArtifacts.value;
  }
  if (manifest.packageVersion !== packageVersion)
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact belongs to another REA version",
      ),
    );
  const selectedArch = architecture ?? topLevelArch;
  if (artifacts === undefined) {
    if (selectedArch !== topLevelArch)
      return err(
        new WindowsNativeArtifactError(
          "Windows native artifact manifest has an invalid architecture",
        ),
      );
    return ok({
      ...topLevelContract,
      packageVersion: manifest.packageVersion,
      artifactSha256: manifest.artifactSha256,
      ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
    });
  }
  const selectedEntry = artifacts[selectedArch];
  if (selectedEntry === undefined)
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid architecture",
      ),
    );
  return ok({
    ...windowsNativeArtifactFor(selectedArch),
    packageVersion: manifest.packageVersion,
    artifactSha256: selectedEntry.artifactSha256,
    ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
    artifacts,
  });
};

const validateWindowsPeArtifact = (
  bytes: Buffer,
  architecture: WindowsNativeArchitecture,
): Result<void, WindowsNativeArtifactError> => {
  const notTarget = () =>
    err(
      new WindowsNativeArtifactError(
        `Windows native artifact is not a Windows ${architecture} PE32+ image`,
      ),
    );
  if (bytes.length < 64 || bytes.toString("latin1", 0, 2) !== "MZ")
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact is not a PE image",
      ),
    );
  const observed = observeMzWindowsHeader(bytes);
  if (observed.state !== "declared" || observed.signature !== "PE")
    return notTarget();
  const offset = observed.offset;
  const coff = readPeCoffHeader(bytes.subarray(offset + 4, offset + 24));
  if (
    !coff.ok ||
    coff.value.machine !== WINDOWS_NATIVE_TARGETS[architecture].machine ||
    coff.value.optionalHeaderSize > bytes.length - offset - 24
  )
    return notTarget();
  const optional = readPeOptionalHeaderIdentity(
    bytes.subarray(offset + 24, offset + 24 + coff.value.optionalHeaderSize),
  );
  if (!optional.ok || optional.value.bits !== 64) return notTarget();
  return ok(undefined);
};

/** Bind the parsed manifest to its exact bytes before native code can load. */
export const validateWindowsNativeArtifact = (
  manifest: WindowsNativeManifest,
  bytes: Buffer,
): Result<void, WindowsNativeArtifactError> => {
  if (
    createHash("sha256").update(bytes).digest("hex") !== manifest.artifactSha256
  )
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact SHA-256 does not match package metadata",
      ),
    );
  return validateWindowsPeArtifact(bytes, manifest.architecture);
};

export interface CreateWindowsNativeManifestOptions {
  readonly architecture?: WindowsNativeArchitecture | undefined;
  readonly sourceSha256?: string | undefined;
  readonly preservedArtifacts?: WindowsNativeArtifactsMap | undefined;
  readonly includeArtifactsTable?: boolean | undefined;
}

/** Produce metadata for a Windows x64 or arm64 PE32+ artifact. */
export const createWindowsNativeManifest = (
  packageVersion: string,
  bytes: Buffer,
  options: CreateWindowsNativeManifestOptions = {},
): Result<WindowsNativeManifest, WindowsNativeArtifactError> => {
  const architecture =
    options.architecture ?? WINDOWS_NATIVE_ARTIFACT.architecture;
  const valid = validateWindowsPeArtifact(bytes, architecture);
  if (!valid.ok) return valid;
  const contract = windowsNativeArtifactFor(architecture);
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const currentEntry = {
    artifact: contract.artifact,
    artifactSha256,
  };
  const includeArtifacts =
    options.includeArtifactsTable === true ||
    options.preservedArtifacts !== undefined;
  const artifacts: WindowsNativeArtifactsMap | undefined = includeArtifacts
    ? {
        ...options.preservedArtifacts,
        ...(architecture === "x64"
          ? { x64: currentEntry as WindowsNativeArtifactEntry<"x64"> }
          : { arm64: currentEntry as WindowsNativeArtifactEntry<"arm64"> }),
      }
    : undefined;
  return parseWindowsNativeManifest(
    {
      ...contract,
      packageVersion,
      artifactSha256,
      ...(options.sourceSha256 === undefined
        ? {}
        : { sourceSha256: options.sourceSha256 }),
      ...(artifacts === undefined ? {} : { artifacts }),
    },
    packageVersion,
    architecture,
  );
};
