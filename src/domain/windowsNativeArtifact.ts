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

/** Packaged artifact and PE machine for each admitted Windows architecture. */
export const WINDOWS_NATIVE_TARGETS = {
  x64: { artifact: "rea-windows-x64.node", machine: 0x8664 },
  arm64: { artifact: "rea-windows-arm64.node", machine: 0xaa64 },
} as const;
export type WindowsNativeArchitecture = keyof typeof WINDOWS_NATIVE_TARGETS;

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
};

export class WindowsNativeArtifactError extends Error {
  readonly _tag = "WindowsNativeArtifactError" as const;
}

/** Parse the exact package manifest before acquiring or loading its artifact. */
export const parseWindowsNativeManifest = (
  value: unknown,
  packageVersion: string,
  architecture: WindowsNativeArchitecture = WINDOWS_NATIVE_ARTIFACT.architecture,
): Result<WindowsNativeManifest, WindowsNativeArtifactError> => {
  const contract = windowsNativeArtifactFor(architecture);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest must be an object",
      ),
    );
  const manifest = value as Record<string, unknown>;
  const keys = [
    "packageVersion",
    ...Object.keys(WINDOWS_NATIVE_ARTIFACT),
    "artifactSha256",
  ];
  if (
    Object.keys(manifest).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(manifest, key))
  )
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has missing or unknown fields",
      ),
    );
  for (const [key, expected] of Object.entries(contract))
    if (manifest[key] !== expected)
      return err(
        new WindowsNativeArtifactError(
          `Windows native artifact manifest has an invalid ${key}`,
        ),
      );
  if (typeof manifest.packageVersion !== "string")
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid packageVersion",
      ),
    );
  if (
    typeof manifest.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.artifactSha256)
  )
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact manifest has an invalid artifactSha256",
      ),
    );
  if (manifest.packageVersion !== packageVersion)
    return err(
      new WindowsNativeArtifactError(
        "Windows native artifact belongs to another REA version",
      ),
    );
  return ok({
    ...contract,
    packageVersion: manifest.packageVersion,
    artifactSha256: manifest.artifactSha256,
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

/** Produce metadata only for a Windows x64 PE32+ artifact. */
export const createWindowsNativeManifest = (
  packageVersion: string,
  bytes: Buffer,
): Result<WindowsNativeManifest, WindowsNativeArtifactError> => {
  const valid = validateWindowsPeArtifact(
    bytes,
    WINDOWS_NATIVE_ARTIFACT.architecture,
  );
  if (!valid.ok) return valid;
  return parseWindowsNativeManifest(
    {
      ...WINDOWS_NATIVE_ARTIFACT,
      packageVersion,
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    },
    packageVersion,
  );
};
