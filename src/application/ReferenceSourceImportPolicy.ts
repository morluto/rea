import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import ignore from "ignore";

import { err, ok, type Result } from "../domain/result.js";
import type { ReferenceSourceLimits } from "../reference/ReferenceSourceReader.js";
import { withinRoot } from "../reference/ReferenceSourceReaderPaths.js";
import {
  DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS,
  DEFAULT_REFERENCE_SOURCE_LIMITS,
  type ReferenceSourceImportError,
  type ReferenceSourceImportOptions,
} from "./ReferenceSourceImportTypes.js";

/** Validated, authorized inputs ready for filesystem traversal. */
export interface PreparedReferenceSourceImport {
  readonly root: string;
  readonly limits: ReferenceSourceLimits;
  readonly ignored: ReturnType<typeof ignore>;
  readonly secrets: ReturnType<typeof ignore>;
}

const failure = (
  code: ReferenceSourceImportError["code"],
  message: string,
): ReferenceSourceImportError => ({
  tag: "reference-source-import",
  code,
  message,
});

const validLimits = (limits: ReferenceSourceLimits): boolean =>
  Object.values(limits).every(
    (value) => Number.isSafeInteger(value) && value > 0,
  );

const maximumLimits = (
  options: ReferenceSourceImportOptions,
): ReferenceSourceLimits => ({
  maxBytes: options.policy.maxBytes,
  maxEntries: options.policy.maxEntries,
  maxDepth: options.policy.maxDepth,
  maxPathBytes: options.policy.maxPathBytes,
});

const clampLimits = (
  requested: ReferenceSourceLimits,
  maximum: ReferenceSourceLimits,
): ReferenceSourceLimits => ({
  maxBytes: Math.min(requested.maxBytes, maximum.maxBytes),
  maxEntries: Math.min(requested.maxEntries, maximum.maxEntries),
  maxDepth: Math.min(requested.maxDepth, maximum.maxDepth),
  maxPathBytes: Math.min(requested.maxPathBytes, maximum.maxPathBytes),
});

const authorizeRoot = async (
  requestedRoot: string,
  approvedRoots: readonly string[],
): Promise<Result<string, ReferenceSourceImportError>> => {
  if (approvedRoots.length === 0)
    return err(failure("policy", "No approved reference source roots"));
  try {
    if (!(await stat(requestedRoot)).isDirectory())
      return err(
        failure("invalid-root", "Reference source root is not a directory"),
      );
    const canonicalRoot = await realpath(resolve(requestedRoot));
    for (const approvedRoot of approvedRoots) {
      const canonicalApproved = await realpath(resolve(approvedRoot));
      if (withinRoot(canonicalApproved, canonicalRoot))
        return ok(canonicalRoot);
    }
    return err(
      failure("policy", "Reference source root is outside approved roots"),
    );
  } catch {
    return err(
      failure("invalid-root", "Reference source root could not be resolved"),
    );
  }
};

const buildIgnored = async (
  root: string,
  excludePaths: readonly string[],
): Promise<ReturnType<typeof ignore>> => {
  const ignored = ignore();
  try {
    ignored.add(await readFile(join(root, ".gitignore"), "utf8"));
  } catch {
    // Missing or unreadable ignore file does not authorize broader access.
  }
  ignored.add([...DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS]);
  for (const path of excludePaths) {
    ignored.add(path);
    ignored.add(`${path}/`);
  }
  return ignored;
};

/** Validate limits, authorize root, and build non-executing path filters. */
export const prepareReferenceSourceImport = async (
  options: ReferenceSourceImportOptions,
): Promise<
  Result<PreparedReferenceSourceImport, ReferenceSourceImportError>
> => {
  const requested = options.limits ?? DEFAULT_REFERENCE_SOURCE_LIMITS;
  const maximum = maximumLimits(options);
  if (!validLimits(requested) || !validLimits(maximum))
    return err(
      failure("invalid-limits", "Import limits must be positive integers"),
    );
  const root = await authorizeRoot(options.root, options.policy.roots);
  if (!root.ok) return root;
  return ok({
    root: root.value,
    limits: clampLimits(requested, maximum),
    ignored: await buildIgnored(root.value, options.excludePaths ?? []),
    secrets: ignore().add([...options.policy.secretPatterns]),
  });
};
