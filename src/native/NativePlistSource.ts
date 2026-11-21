import {
  readerIntegrityFailure,
  artifactSelectedPathErrno,
  assertArtifactSelectedSource,
  mapArtifactFileFailure,
  resolveArtifactSourcePath,
  ArtifactReaderFailure,
  ArtifactFileCleanupFailure,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
  assertArtifactReadActive,
  withArtifactRegularFile,
  type ArtifactResourceScope,
} from "../resources/index.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { realpath, stat, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isPathWithinRoot } from "../domain/localPath.js";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { z } from "zod";
import type { inspectPlistSchema } from "../domain/native/nativeInspection.js";
import type { ResolvedAppBundleResourceRoot } from "../domain/apple/bundleResourceRoot.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  assertStableRegularFileIdentity,
  RegularFileChangedError,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY } from "./NativeMacosProviderIdentity.js";
import {
  MAX_NATIVE_PLIST_BYTES,
  nativePlistInputAllowance,
} from "./parsers/plist.js";
import { errorMessage } from "../kernel/errorMessage.js";

/**
 * Resolved lookup identity and selection intent, independent of file readiness.
 * `selected` came from the caller's `path` input, `target` is the session
 * target itself, and `default` is the bundle's Info.plist.
 */
export interface NativePlistSelection {
  readonly path: string;
  readonly origin: "selected" | "target" | "default";
  readonly bundleRoot?: string;
}

/** Resolve intent once; consumers never infer it from an omitted tool argument. */
export const resolveNativePlistSelection = async (
  target: BinaryTarget,
  requested: string | undefined,
): Promise<Result<NativePlistSelection, AnalysisError>> => {
  try {
    if (
      requested === undefined &&
      target.kind === "artifact" &&
      target.format === "plist"
    )
      return ok({ path: target.path, origin: "target" });
    const source = target.sourcePath ?? target.path;
    // Bundle admission records the source directory independently of its
    // present readiness. A lost root cannot become a standalone selection.
    const bundleRoot =
      target.bundleInfoPlist !== undefined && source !== target.path
        ? source
        : macOSBundleRoot(target.path);
    if (bundleRoot !== undefined)
      return ok(
        bundlePlistSelection(
          bundleRoot,
          target.bundleInfoPlist ?? resolve(bundleRoot, "Contents/Info.plist"),
          requested,
        ),
      );
    if (requested !== undefined && isAbsolute(requested))
      return ok({ path: absoluteCallerPath(requested), origin: "selected" });

    const root = (await stat(source)).isDirectory()
      ? source
      : dirname(target.path);
    if (requested !== undefined)
      return ok({
        path: absoluteCallerPath(requested, { cwd: root }),
        origin: "selected",
      });
    return ok({
      path: target.bundleInfoPlist ?? resolve(root, "Contents/Info.plist"),
      origin: "default",
    });
  } catch (cause: unknown) {
    return err(
      new ProviderAdapterError(IDENTITY.id, "inspect_plist", { cause }),
    );
  }
};

/** Resolve a plist selection from the separately identified app resource root. */
export const resolveBundleResourcePlistSelection = (
  root: ResolvedAppBundleResourceRoot,
  requested: string | undefined,
): Result<NativePlistSelection, AnalysisError> => {
  return ok(
    bundlePlistSelection(root.canonicalPath, root.infoPlistPath, requested),
  );
};

const bundlePlistSelection = (
  bundleRoot: string,
  infoPlist: string,
  requested: string | undefined,
): NativePlistSelection =>
  requested === undefined
    ? { path: infoPlist, origin: "default", bundleRoot }
    : {
        path: absoluteCallerPath(requested, { cwd: bundleRoot }),
        origin: "selected",
        bundleRoot,
      };

/** The bundle whose Contents/MacOS directory directly holds the program. */
const macOSBundleRoot = (path: string): string | undefined => {
  const programs = dirname(path);
  const contents = dirname(programs);
  return basename(programs) === "MacOS" && basename(contents) === "Contents"
    ? dirname(contents)
    : undefined;
};

/**
 * Report a plist that cannot be decoded against the input that chose it: the
 * caller's `path` selection, the session target itself, or the target's
 * missing default, rather than as a failed tool run.
 */
export const unreadablePlist = (
  selection: NativePlistSelection,
  reason: string,
  options?: AnalysisErrorOptions,
): AnalysisError => {
  const { path } = selection;
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;
  switch (selection.origin) {
    case "default": {
      // Name the default that is missing and the selection that still works.
      const missingDefault = `The target has no readable default plist at ${path}: ${sentence} Select another plist in the target with the path input.`;
      return new AnalysisCapabilityUnavailableError(
        IDENTITY.id,
        "inspect_plist",
        missingDefault,
        {
          ...options,
          userMessage: missingDefault,
          related: { parameters: ["path"] },
        },
      );
    }
    case "target":
      // The caller sent no `path`; the open target is the plist that failed.
      return new BinaryTargetError(
        path,
        `cannot inspect it as a property list: ${sentence}`,
        options,
      );
    case "selected":
      return new AnalysisInputError("inspect_plist", options, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Cannot inspect ${path}: ${sentence}`,
        },
      ]);
  }
};

interface PlistFileInput {
  readonly selection: NativePlistSelection;
  readonly resources: ArtifactResourceScope;
  readonly signal: AbortSignal | undefined;
}

/** Translate only physical file outcomes, never a later signal or arbitrary abort value. */
export const nativePlistFailure = (
  cause: unknown,
  selection: NativePlistSelection | undefined,
): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const physical =
      cause instanceof ArtifactFileCleanupFailure
        ? cause.fileCleanupFailure
        : undefined;
    const previous =
      physical?.outcome.kind === "failed"
        ? nativePlistPrimaryFailure(artifactFilePrimaryFacts(cause), selection)
        : physical?.completionCancellation === undefined
          ? undefined
          : cancelledBy(
              "inspect_plist",
              carriedReason(physical.completionCancellation.reason),
            );
    const previousProjection =
      previous === undefined ? null : projectAnalysisError(previous);
    const failure = new ProviderCleanupError(
      IDENTITY.id,
      cause.cleanup.resources,
      {
        reason: cause.cleanup.reason,
        previous_error: previousProjection,
      },
      {
        operation: "inspect_plist",
        cause,
        cleanupPrimary: previous,
      },
    );
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
  return nativePlistPrimaryFailure(artifactFilePrimaryFacts(cause), selection);
};

const nativePlistPrimaryFailure = (
  { cause, origin }: ArtifactFilePrimaryFacts,
  selection: NativePlistSelection | undefined,
): AnalysisError => {
  if (origin === "owned-or-classified") {
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
      return cancelledBy(
        "inspect_plist",
        carriedReason(artifactFileCancellationCause(cause)),
      );
    if (
      cause instanceof ArtifactReaderFailure &&
      cause.reason === "unavailable"
    )
      return new AnalysisCapabilityUnavailableError(
        IDENTITY.id,
        "inspect_plist",
        cause.message,
        { cause },
      );
    if (
      selection !== undefined &&
      cause instanceof ArtifactReaderFailure &&
      cause.reason === "integrity"
    )
      return readerIntegrityFailure("inspect_plist", selection.path, cause);
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit") {
      const resource = cause.boundary ?? "memory";
      return resource === "file-size"
        ? new AnalysisResourceConstraintError(
            "inspect_plist",
            resource,
            cause.message,
            { maximum_input_bytes: MAX_NATIVE_PLIST_BYTES },
            {
              cause,
              ...nativePlistInputAllowance(),
            },
          )
        : new AnalysisResourceConstraintError(
            "inspect_plist",
            resource,
            cause.message,
            null,
            { cause, retryable: false },
          );
    }
  }
  if (selection === undefined)
    return new ProviderAdapterError(IDENTITY.id, "inspect_plist", {
      cause,
      diagnostics: {
        phase: "plist-scope",
        reason: errorMessage(cause),
      },
    });
  const { path } = selection;
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR")
    return unreadablePlist(selection, "no file exists there", {
      cause,
    });
  if (code === "EISDIR" || code === "ENOTFILE")
    return unreadablePlist(selection, "it is not a regular file", {
      cause,
    });
  if (code === "ELOOP" || code === "ENAMETOOLONG")
    return unreadablePlist(
      selection,
      code === "ELOOP"
        ? "symbolic-link traversal looped or exceeded the host limit (ELOOP)"
        : "the path exceeds the host path or component length limit (ENAMETOOLONG)",
      { cause },
    );
  if (code === "EACCES" || code === "EPERM")
    return new BinaryTargetError(
      path,
      `permission denied while reading plist (${code})`,
      { cause },
    );
  return new ProviderAdapterError(IDENTITY.id, "inspect_plist", {
    cause,
    diagnostics: {
      path,
      phase: "plist-file",
      reason: errorMessage(cause),
    },
  });
};

interface AdmittedBundlePlist {
  readonly root: string;
  readonly directory: BigIntStats;
  readonly path: string;
}

const rootChanged = (root: string, options: AnalysisErrorOptions = {}) =>
  new AnalysisArtifactChangedError(
    "inspect_plist",
    root,
    `The opened Apple bundle root changed or is no longer a directory: ${root}`,
    { ...options, integrityCheck: "container-identity" },
  );

const observePlistRoot = async (root: string): Promise<BigIntStats> => {
  try {
    const directory = await stat(`${root}/.`, { bigint: true });
    // Both active target roots and resource roots are recorded canonically.
    // A later alias must not silently move the scope to another directory.
    if (!directory.isDirectory() || (await realpath(root)) !== root)
      throw rootChanged(root);
    return directory;
  } catch (cause: unknown) {
    const code =
      cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code === "EACCES" || code === "EPERM")
      throw new AnalysisAccessDeniedError("inspect_plist", root, code, {
        cause,
      });
    if (artifactSelectedPathErrno(cause) !== undefined)
      throw rootChanged(root, { cause });
    throw cause;
  }
};

const assertPlistRootIdentity = (
  root: string,
  expected: BigIntStats,
  observed: BigIntStats,
): void => {
  if (expected.dev !== observed.dev || expected.ino !== observed.ino)
    throw rootChanged(root);
};

const plistOutsideBundle = (selection: NativePlistSelection): AnalysisError => {
  const reason = "it resolves outside the opened bundle";
  if (selection.origin === "default") return unreadablePlist(selection, reason);
  const message = `Cannot inspect ${selection.path}: ${reason}. Open that plist as its own target.`;
  return new AnalysisInputError(
    "inspect_plist",
    {
      userMessage: message,
      remediationAction: "Open that plist as its own target.",
    },
    [{ path: ["path"], reason: "invalid_value", message }],
  );
};

/** Resolve the path once for admission, without giving it to command producers. */
const admitBundlePlist = async (
  selection: NativePlistSelection,
  root: string,
): Promise<AdmittedBundlePlist> => {
  const directory = await observePlistRoot(root);
  const path = await resolveArtifactSourcePath(selection.path);
  if (!isPathWithinRoot(root, path)) throw plistOutsideBundle(selection);
  return { root, directory, path };
};

const plistPathChanged = (selection: NativePlistSelection, cause?: unknown) =>
  new ArtifactReaderFailure(
    "integrity",
    `Selected plist changed during read: ${selection.path}`,
    { cause, integrityCheck: "container-identity" },
  );

const classifyBundlePlistChange = (
  cause: unknown,
  selection: NativePlistSelection,
): unknown =>
  artifactSelectedPathErrno(cause) !== undefined ||
  cause instanceof RegularFileChangedError
    ? plistPathChanged(selection, cause)
    : cause;

const verifyBundlePlist = async (
  selection: NativePlistSelection,
  admitted: AdmittedBundlePlist,
  file: FileHandle,
  initial: BigIntStats,
  signal: AbortSignal | undefined,
): Promise<void> => {
  assertArtifactReadActive(signal);
  assertPlistRootIdentity(
    admitted.root,
    admitted.directory,
    await observePlistRoot(admitted.root),
  );
  try {
    // Resolve the user's spelling again so an alias change cannot silently
    // select a different source. Compare the named file to this exact open.
    await assertArtifactSelectedSource(admitted.path, selection.path);
    await assertStableRegularFileIdentity(file, admitted.path, initial, {
      symlinks: "reject",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause: unknown) {
    throw classifyBundlePlistChange(cause, selection);
  }
};

/** The admitted path and the owned descriptor must agree before reading. */
export const readNativePlistBytes = async (
  input: PlistFileInput,
): Promise<Result<Buffer, AnalysisError>> => {
  const { selection, resources, signal } = input;
  let admitted: AdmittedBundlePlist | undefined;
  try {
    assertArtifactReadActive(signal);
    admitted =
      selection.bundleRoot === undefined
        ? undefined
        : await admitBundlePlist(selection, selection.bundleRoot);
    const path = admitted?.path ?? selection.path;
    return ok(
      await withArtifactRegularFile(
        path,
        resources,
        signal,
        async ({ handle }) => {
          const before = await handle.stat({ bigint: true });
          if (admitted !== undefined)
            await verifyBundlePlist(
              selection,
              admitted,
              handle,
              before,
              signal,
            );
          const bytes = await readPlistSourceBytes(input, handle, before);
          if (admitted !== undefined)
            await verifyBundlePlist(
              selection,
              admitted,
              handle,
              before,
              signal,
            );
          return bytes;
        },
        admitted === undefined ? "follow" : "reject",
      ),
    );
  } catch (cause: unknown) {
    const primary =
      admitted === undefined
        ? cause
        : mapArtifactFileFailure(cause, (failure) =>
            classifyBundlePlistChange(failure, selection),
          );
    return err(nativePlistFailure(primary, selection));
  }
};

const readPlistSourceBytes = async (
  input: PlistFileInput,
  file: FileHandle,
  before: BigIntStats,
): Promise<Buffer> => {
  if (before.size > BigInt(MAX_NATIVE_PLIST_BYTES))
    throw new ArtifactReaderFailure(
      "limit",
      `Selected plist exceeds ${String(MAX_NATIVE_PLIST_BYTES)} bytes: ${input.selection.path}. This release has no runtime override for this ${String(MAX_NATIVE_PLIST_BYTES)}-byte allowance.`,
      { boundary: "file-size" },
    );
  const bytes = Buffer.allocUnsafe(Number(before.size));
  let position = 0;
  while (position < bytes.length) {
    assertArtifactReadActive(input.signal);
    const length = Math.min(64 * 1024, bytes.length - position);
    const { bytesRead } = await file.read(bytes, position, length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
  }
  const after = await file.stat({ bigint: true });
  if (after.size > BigInt(MAX_NATIVE_PLIST_BYTES))
    throw new ArtifactReaderFailure(
      "limit",
      `Selected plist grew beyond ${String(MAX_NATIVE_PLIST_BYTES)} bytes: ${input.selection.path}. This release has no runtime override for this ${String(MAX_NATIVE_PLIST_BYTES)}-byte allowance.`,
      { boundary: "file-size" },
    );
  if (!sameRegularFileState(before, after) || BigInt(position) !== before.size)
    throw new ArtifactReaderFailure(
      "integrity",
      `Selected plist changed during read: ${input.selection.path}`,
      { integrityCheck: "container-identity" },
    );
  assertArtifactReadActive(input.signal);
  return bytes;
};

/**
 * Bytes examined for leading markup when `file` reports only text.
 * This is a probe window, not a document cap, and has no runtime override.
 */
const PLIST_MARKUP_PROBE_BYTES = 4096;

/** Source classification remains independent of plutil's converted value format. */
export const plistSourceFormat = (
  description: string,
  source: Uint8Array,
): z.infer<typeof inspectPlistSchema>["format"] => {
  if (/binary property list/iu.test(description)) return "binary";
  if (/\bXML\b/iu.test(description)) return "xml";
  if (/\bJSON\b/iu.test(description)) return "json";
  if (!/\btext\b/iu.test(description)) return "unknown";
  const head = source.subarray(0, PLIST_MARKUP_PROBE_BYTES);
  const encoding =
    head[0] === 0xff && head[1] === 0xfe
      ? "utf-16le"
      : head[0] === 0xfe && head[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const text = new TextDecoder(encoding).decode(head).trimStart();
  return /^<(?:[!?]|(?:plist|dict|array|string|integer|real|data|date|true|false)[\s/>])/u.test(
    text,
  )
    ? "xml"
    : "unknown";
};
