import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

import {
  ArtifactResourceScope,
  type ArtifactCleanupAttempt,
} from "../../artifacts/ArtifactResourceScope.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  outputDirectoryAdmissionRefusal,
  SafeOutputTreeDestinationRefusal,
} from "../../artifacts/SafeOutputTreeAdmission.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../../filesystem/callerPath.js";

/** A published tree whose output handles could not be released. */
export type FailedRelease = Extract<
  ArtifactCleanupAttempt,
  { readonly kind: "failed" }
>;

const UNAVAILABLE_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "ENAMETOOLONG",
]);

const errnoCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const assertWritableDirectory = async (
  path: string,
  message: string,
): Promise<void> => {
  try {
    await access(path, constants.W_OK | constants.X_OK);
  } catch (cause: unknown) {
    if (UNAVAILABLE_CODES.has(errnoCode(cause) ?? "")) {
      const text = `${message}: ${path}`;
      throw new SafeOutputTreeDestinationRefusal(text, { cause });
    }
    throw cause;
  }
};

/** Nearest existing ancestor directory for a parent path mkdir completes. */
const resolveExistingAncestor = async (
  selectedParent: string,
): Promise<string> => {
  let current = selectedParent;
  while (true) {
    try {
      const metadata = await stat(current);
      if (!metadata.isDirectory()) {
        const text = `Output parent must be a directory: ${current}`;
        throw new SafeOutputTreeDestinationRefusal(text);
      }
      return current;
    } catch (cause: unknown) {
      if (cause instanceof SafeOutputTreeDestinationRefusal) throw cause;
      const code = errnoCode(cause);
      if (code === "ENOENT") {
        const dangling = await lstat(current).then(
          () => true,
          () => false,
        );
        const step = basename(current);
        const next = dirname(current);
        if (!dangling && step !== "." && step !== ".." && next !== current) {
          current = next;
          continue;
        }
      }
      if (UNAVAILABLE_CODES.has(code ?? "")) {
        const text = `Output parent is unavailable: ${current}`;
        throw new SafeOutputTreeDestinationRefusal(text, { cause });
      }
      throw cause;
    }
  }
};

const admitExistingOrAbsentTarget = async (
  selectedParent: string,
  target: string,
): Promise<void> => {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(target);
  } catch (cause: unknown) {
    const code = errnoCode(cause);
    if (code === "ENOENT") {
      await assertWritableDirectory(
        selectedParent,
        "Output parent is not writable",
      );
      return;
    }
    if (UNAVAILABLE_CODES.has(code ?? "")) {
      const text = `Output path is unavailable: ${target}`;
      throw new SafeOutputTreeDestinationRefusal(text, { cause });
    }
    throw cause;
  }
  if (!entry.isDirectory()) {
    const text = `Output destination must be a directory: ${target}`;
    throw new SafeOutputTreeDestinationRefusal(text);
  }
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch (cause: unknown) {
    if (UNAVAILABLE_CODES.has(errnoCode(cause) ?? "")) {
      const text = `Output directory is unavailable: ${target}`;
      throw new SafeOutputTreeDestinationRefusal(text, { cause });
    }
    throw cause;
  }
  if (entries.length > 0) {
    const text = `Output directory is not empty: ${target}`;
    throw new SafeOutputTreeDestinationRefusal(text);
  }
  await assertWritableDirectory(target, "Output directory is not writable");
};

const admitOutputDirectory = async (directory: string): Promise<string> => {
  if (!isAbsolute(directory)) {
    const text = "Output root must be absolute";
    throw new SafeOutputTreeDestinationRefusal(text);
  }
  const requested = absoluteCallerPath(directory);
  const name = basename(requested);
  if (name === "" || name === "." || name === "..") {
    const text = "Invalid output directory";
    throw new SafeOutputTreeDestinationRefusal(text);
  }
  const selectedParent = dirname(requested);
  const ancestor = await resolveExistingAncestor(selectedParent);
  if (ancestor !== selectedParent) {
    await assertWritableDirectory(ancestor, "Output parent is not writable");
    return selectedParent;
  }
  await admitExistingOrAbsentTarget(
    selectedParent,
    appendCallerPath(selectedParent, name),
  );
  return selectedParent;
};

const ensureParentDirectory = async (parent: string): Promise<void> => {
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
  } catch (cause: unknown) {
    const code = errnoCode(cause);
    if (code === "EEXIST" || UNAVAILABLE_CODES.has(code ?? "")) {
      const text = `Output parent is unavailable: ${parent}`;
      throw new SafeOutputTreeDestinationRefusal(text, { cause });
    }
    throw cause;
  }
};

/**
 * Admit a new or empty output folder before work with external side effects
 * begins; `writeOutputTree` rechecks and acquires the tree when writing.
 */
export const checkOutputTreeDestination = async (
  directory: string,
  context: {
    readonly provider: string;
    readonly operation: string;
    readonly field: string;
  },
): Promise<Result<void, AnalysisError>> => {
  try {
    await admitOutputDirectory(directory);
    return ok(undefined);
  } catch (cause: unknown) {
    const mapped = outputDirectoryAdmissionRefusal(
      context.operation,
      context.field,
      cause,
    );
    if (mapped instanceof AnalysisError) return err(mapped);
    const reason = mapped instanceof Error ? mapped.message : String(mapped);
    return err(
      new ProviderAdapterError(context.provider, context.operation, {
        userMessage: `Could not inspect ${directory}: ${reason}`,
        cause: mapped,
      }),
    );
  }
};

/**
 * Write a new or empty folder through the safe output tree, rolling an
 * unpublished tree back on any failure so no partial copy remains. A
 * published tree is kept; a failed release of its handles is returned. A
 * refused destination names the caller's `field` under `operation`.
 */
export const writeOutputTree = async (
  directory: string,
  write: (tree: SafeOutputTree) => Promise<void>,
  refusal: { readonly operation: string; readonly field: string },
  signal: AbortSignal | undefined,
): Promise<FailedRelease | undefined> => {
  const resources = new ArtifactResourceScope();
  let tree: SafeOutputTree | undefined;
  let outcome:
    | { readonly kind: "completed" }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    const selectedParent = await admitOutputDirectory(directory);
    await ensureParentDirectory(selectedParent);
    try {
      tree = await SafeOutputTree.create(directory, process.platform, {
        acceptExistingEmpty: true,
      });
    } catch (cause: unknown) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      throw cause;
    }
    await write(tree);
    await tree.commit(signal);
    outcome = { kind: "completed" };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  if (tree !== undefined) {
    const released = await resources.release({
      kind: "output-tree",
      resource: directory,
      tree,
    });
    if (released.kind === "failed") {
      if (tree.published) return released;
      throw resources.cleanupFailure(outcome, [released]);
    }
    if (tree.published) return undefined;
  }
  if (outcome.kind === "failed")
    throw outputDirectoryAdmissionRefusal(
      refusal.operation,
      refusal.field,
      outcome.cause,
    );
  return undefined;
};

/** A complete folder whose output handles could not be closed, reported with what it holds. */
export const writtenWithOpenHandles = (
  context: {
    readonly provider: string;
    readonly operation: string;
    readonly what: string;
  },
  directory: string,
  release: FailedRelease,
  evidence?: Evidence,
): ProviderAdapterError => {
  const reason =
    release.cause instanceof Error
      ? release.cause.message
      : String(release.cause);
  const error = new ProviderAdapterError(context.provider, context.operation, {
    userMessage: `The ${context.what} was written to ${directory} and is complete, but its output handles could not be closed: ${reason}.`,
    remediationAction: `Use the written ${context.what}; the handles are released when this process exits.`,
    cleanup: { reason, resources: [directory] },
    ...(evidence === undefined ? {} : { partialObservation: evidence }),
    diagnostics: { output_directory: directory },
  });
  release.lease.bindCleanupError(error);
  return error;
};
