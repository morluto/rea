import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import ignore from "ignore";

import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS,
  type ReferenceSourceImportError,
  type ReferenceSourceImportOptions,
} from "./ReferenceSourceImportTypes.js";

/** Validated inputs ready for filesystem traversal. */
export interface PreparedReferenceSourceImport {
  readonly root: string;
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

const resolveRoot = async (
  requestedRoot: string,
): Promise<Result<string, ReferenceSourceImportError>> => {
  try {
    if (!(await stat(requestedRoot)).isDirectory())
      return err(
        failure("invalid-root", "Reference source root is not a directory"),
      );
    const canonicalRoot = await realpath(resolve(requestedRoot));
    return ok(canonicalRoot);
  } catch (cause: unknown) {
    void cause;
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
  } catch (cause: unknown) {
    // Missing or unreadable ignore file does not authorize broader access.
    void cause;
  }
  ignored.add([...DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS]);
  for (const path of excludePaths) {
    ignored.add(path);
    ignored.add(`${path}/`);
  }
  return ignored;
};

/** Resolve the caller-selected directory and build path filters. */
export const prepareReferenceSourceImport = async (
  options: ReferenceSourceImportOptions,
): Promise<
  Result<PreparedReferenceSourceImport, ReferenceSourceImportError>
> => {
  const root = await resolveRoot(options.root);
  if (!root.ok) return root;
  return ok({
    root: root.value,
    ignored: await buildIgnored(root.value, options.excludePaths ?? []),
    secrets: ignore().add([...options.policy.secretPatterns]),
  });
};
