import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { BinaryTarget } from "../../domain/binaryTarget.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { nativeAotAdapter } from "./nativeaot/NativeAotAdapter.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Exact executable extension artifact committed before the session starts. */
export const ghidraExtensionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  path: z.string().refine(isAbsolute, "Extension path must be absolute"),
  configured_path: z
    .string()
    .refine(isAbsolute, "Extension path must be absolute"),
  sha256: digest,
  entry_class: z.string().min(1),
  integration_api: z.literal(1),
});
export type GhidraExtension = z.infer<typeof ghidraExtensionSchema>;

/** Shared extension envelope; each adapter validates its own producer result. */
export const ghidraExtensionResultSchema = z.strictObject({
  id: z.string().min(1),
  sha256: digest,
  status: z.enum([
    "complete",
    "partial",
    "not_applicable",
    "unsupported",
    "failed",
  ]),
  reason: z.string().nullable(),
  result: jsonObjectSchema,
});
export type GhidraExtensionResult = z.infer<typeof ghidraExtensionResultSchema>;

/** Provider-local registration contract for independently replaceable analysis adapters. */
export interface GhidraExtensionAdapter {
  readonly id: string;
  readonly entryClass: string;
  configuredPath(config: AppConfig): string | undefined;
  unsupportedReason(
    target: BinaryTarget,
    platform: NodeJS.Platform,
  ): string | null;
  validate(result: GhidraExtensionResult): string | null;
  readonly limitations: readonly string[];
}

const adapters: readonly GhidraExtensionAdapter[] = [nativeAotAdapter];
const MAX_EXTENSION_BYTES = 8 * 1024 * 1024;

/** Read a bounded regular artifact through its open handle, without ambient state changes. */
const readJar = async (path: string): Promise<Buffer> => {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 4 || stat.size > MAX_EXTENSION_BYTES)
      throw new Error(
        `Ghidra extension must be a regular JAR of 4..${MAX_EXTENSION_BYTES} bytes: ${path}`,
      );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0)
        throw new Error(`Incomplete Ghidra extension read: ${path}`);
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if (
      (await file.read(extra, 0, 1, offset)).bytesRead !== 0 ||
      bytes.readUInt32LE(0) !== 0x04034b50
    )
      throw new Error(
        `Ghidra extension changed during read or is not a JAR: ${path}`,
      );
    return bytes;
  } finally {
    await file.close();
  }
};

/** Resolve explicitly configured optional extensions into the immutable analysis profile. */
export const resolveGhidraExtensions = async (
  config: AppConfig,
  target: BinaryTarget,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<Result<readonly GhidraExtension[], AnalysisError>> => {
  const extensions: GhidraExtension[] = [];
  for (const adapter of adapters) {
    if (signal?.aborted) return err(new AnalysisCancelledError("open_binary"));
    const configured = adapter.configuredPath(config);
    if (configured === undefined) continue;
    const reason = adapter.unsupportedReason(target, platform);
    if (reason !== null)
      return err(
        new ProviderAdapterError("ghidra", "resolve_analysis_profile", {
          diagnostics: { extension: adapter.id, reason, path: configured },
        }),
      );
    try {
      const path = await realpath(configured);
      const bytes = await readJar(path);
      extensions.push({
        id: adapter.id,
        path,
        configured_path: configured,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        entry_class: adapter.entryClass,
        integration_api: 1,
      });
    } catch (cause: unknown) {
      return err(
        new ProviderAdapterError("ghidra", "resolve_analysis_profile", {
          cause,
          diagnostics: {
            extension: adapter.id,
            path: configured,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      );
    }
  }
  if (signal?.aborted) return err(new AnalysisCancelledError("open_binary"));
  return ok(extensions);
};

/** Require explicit local configuration before admitting executable code from a profile. */
export const validateGhidraExtensionProfile = (
  extensions: readonly GhidraExtension[],
  config: AppConfig,
  target: BinaryTarget,
  platform: NodeJS.Platform,
): string | null => {
  const enabled = adapters.filter(
    (adapter) => adapter.configuredPath(config) !== undefined,
  );
  if (
    enabled.length !== extensions.length ||
    new Set(extensions.map((extension) => extension.id)).size !==
      extensions.length
  )
    return "Configured Ghidra extension inventory differs from the resolved analysis profile.";
  for (const extension of extensions) {
    const adapter = enabled.find((value) => value.id === extension.id);
    if (
      adapter === undefined ||
      adapter.entryClass !== extension.entry_class ||
      adapter.configuredPath(config) !== extension.configured_path
    )
      return `Ghidra extension profile lacks matching explicit local configuration: ${extension.id}`;
    const reason = adapter.unsupportedReason(target, platform);
    if (reason !== null) return reason;
  }
  return null;
};

/** Snapshot committed extension bytes into the private runtime before Java loads them. */
export const snapshotGhidraExtensions = async (
  extensions: readonly GhidraExtension[],
  runtimeRoot: string,
): Promise<readonly GhidraExtension[]> => {
  if (extensions.length === 0) return [];
  for (const extension of extensions) {
    ghidraExtensionSchema.parse(extension);
    const adapter = adapters.find((value) => value.id === extension.id);
    if (adapter === undefined || adapter.entryClass !== extension.entry_class)
      throw new Error(
        `Unregistered Ghidra extension identity: ${extension.id}`,
      );
    if ((await realpath(extension.configured_path)) !== extension.path)
      throw new Error(
        `Ghidra extension resolved path differs from explicit configuration: ${extension.id}`,
      );
  }
  const directory = join(runtimeRoot, "extensions");
  await mkdir(directory, { mode: 0o700 });
  const result: GhidraExtension[] = [];
  for (const extension of extensions) {
    const bytes = await readJar(extension.path);
    if (createHash("sha256").update(bytes).digest("hex") !== extension.sha256)
      throw new Error(
        `Ghidra extension digest differs from committed profile: ${extension.id} (${extension.path})`,
      );
    const path = join(directory, `${extension.id}.jar`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    result.push({ ...extension, path });
  }
  return result;
};

/** Require every configured producer result to match its artifact and registered ABI. */
export const validateGhidraExtensionResults = (
  expected: readonly GhidraExtension[],
  results: readonly GhidraExtensionResult[],
): string | null => {
  if (
    results.length !== expected.length ||
    new Set(results.map((result) => result.id)).size !== results.length
  )
    return "Ghidra extension result inventory differs from its committed profile.";
  for (const extension of expected) {
    const result = results.find((value) => value.id === extension.id);
    const adapter = adapters.find((value) => value.id === extension.id);
    if (
      result === undefined ||
      adapter === undefined ||
      result.sha256 !== extension.sha256
    )
      return `Ghidra extension identity mismatch: ${extension.id}`;
    const invalid = adapter.validate(result);
    if (invalid !== null) return invalid;
  }
  return null;
};

/** Exact adapter limitations for explicitly configured session extensions. */
export const ghidraExtensionLimitations = (
  extensions: readonly GhidraExtension[],
): readonly string[] =>
  adapters
    .filter((adapter) =>
      extensions.some((extension) => extension.id === adapter.id),
    )
    .flatMap((adapter) => adapter.limitations);
