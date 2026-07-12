import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

import { err, ok } from "../domain/result.js";
import { cancelled, failure } from "./ReferenceSourceReaderErrors.js";
import { withinRoot } from "./ReferenceSourceReaderPaths.js";
import {
  type BigStats,
  type ReferenceSourceFailureCode,
  type ReferenceSourceLimits,
  type ReferenceSourceResult,
} from "./ReferenceSourceReaderTypes.js";

export const bigLstat = (path: string): Promise<BigStats> =>
  lstat(path, { bigint: true });

export const sameFile = (left: BigStats, right: BigStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

export const isAborted = (signal?: AbortSignal): boolean =>
  signal?.aborted === true;

const validLimits = (limits: ReferenceSourceLimits): boolean =>
  Object.values(limits).every(
    (value) => Number.isSafeInteger(value) && value > 0,
  );

export const noFollowOpenSupported = (): boolean =>
  Number.isSafeInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0;

export const validateDirectory = async (
  root: string,
  rootIdentity: BigStats,
  path: string,
): Promise<
  | { readonly ok: true; readonly stats: BigStats }
  | {
      readonly ok: false;
      readonly code: ReferenceSourceFailureCode;
      readonly message: string;
    }
> => {
  try {
    const rootNow = await bigLstat(root);
    if (!sameFile(rootIdentity, rootNow))
      return { ok: false, code: "changed", message: "Reference root changed" };
    const stats = await bigLstat(path);
    if (stats.isSymbolicLink())
      return {
        ok: false,
        code: "symlink",
        message: "Symbolic links are not followed",
      };
    if (!stats.isDirectory())
      return {
        ok: false,
        code: "changed",
        message: "Directory identity changed",
      };
    const canonical = await realpath(path);
    if (canonical !== path || !withinRoot(root, canonical))
      return {
        ok: false,
        code: "changed",
        message: "Directory escaped the reference root",
      };
    return { ok: true, stats };
  } catch {
    return {
      ok: false,
      code: "io",
      message: "Directory identity could not be verified",
    };
  }
};

export const prepareRoot = async (
  root: string,
  limits: ReferenceSourceLimits,
  signal?: AbortSignal,
): Promise<
  ReferenceSourceResult<{
    readonly canonicalRoot: string;
    readonly rootIdentity: BigStats;
  }>
> => {
  if (!validLimits(limits))
    return err(
      failure("invalid-limits", "Reader limits must be positive integers"),
    );
  if (isAborted(signal)) return err(cancelled());
  try {
    const metadata = await bigLstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      return err(
        failure("invalid-root", "Reference source root must be a directory"),
      );
    const canonicalRoot = await realpath(root);
    if (isAborted(signal)) return err(cancelled());
    const canonicalMetadata = await bigLstat(canonicalRoot);
    if (!sameFile(metadata, canonicalMetadata))
      return err(
        failure(
          "invalid-root",
          "Reference source root changed during resolution",
        ),
      );
    return ok({ canonicalRoot, rootIdentity: canonicalMetadata });
  } catch {
    return err(
      failure("invalid-root", "Reference source root could not be resolved"),
    );
  }
};
