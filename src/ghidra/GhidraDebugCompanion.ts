import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import type { JsonValue } from "../domain/jsonValue.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
} from "../domain/analysisErrorCore.js";
import type { MachODebugCompanion } from "../domain/binaryTargetTypes.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  assertArtifactReadActive,
  mapArtifactFileFailure,
  withArtifactFileHandle,
  withArtifactRegularFile,
} from "../artifacts/ArtifactFileOperation.js";
import { readArtifactFileChunks } from "../artifacts/readArtifactFileChunks.js";
import {
  NonRegularFileReadError,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";

/**
 * Stage an admitted dSYM companion beside the private target snapshot.
 *
 * Ghidra's DSymSectionProvider looks up external DWARF by strict file naming:
 * `<snapshot directory>/<snapshot name>.dSYM/Contents/Resources/DWARF/<snapshot
 * name>`. The staged DWARF member is therefore copied under the snapshot's
 * name; the caller's bundle on disk is never modified.
 *
 * Both descriptors live under the shared artifact file owners, exactly like
 * the target snapshot: the source is admitted as a non-blocking regular file,
 * each close runs before the staged tree is removed, a failed close retains
 * its owner in the resource scope for shutdown retry, and a primary copy or
 * digest failure is never replaced by a later close rejection.
 */
export const stageGhidraDebugCompanion = async (
  companion: MachODebugCompanion,
  runtimeRoot: string,
  snapshotPath: string,
  options: {
    readonly signal?: AbortSignal;
    readonly resourceScope?: ArtifactResourceScope;
  } = {},
): Promise<JsonValue> => {
  const snapshotName = basename(snapshotPath);
  const stagedBundle = join(runtimeRoot, `${snapshotName}.dSYM`);
  const stagedDirectory = join(stagedBundle, "Contents", "Resources", "DWARF");
  const stagedMember = join(stagedDirectory, snapshotName);
  const resources = options.resourceScope ?? new ArtifactResourceScope();
  const { signal } = options;
  try {
    await mkdir(stagedDirectory, { recursive: true });
    return await resources.run(() =>
      withArtifactRegularFile(
        companion.memberPath,
        resources,
        signal,
        async ({ handle: source }) => {
          const initial = await source.stat({ bigint: true });
          assertArtifactReadActive(signal);
          return await withArtifactFileHandle(
            stagedMember,
            await open(stagedMember, "wx", 0o600),
            resources,
            signal,
            async (destination) => {
              await destination.chmod(0o600);
              const hash = createHash("sha256");
              // The admitted size bounds the staged copy; growth past it is
              // reported below instead of staging a matching prefix.
              const input = readArtifactFileChunks(source, {
                end: companion.memberSizeBytes,
                signal,
              });
              for await (const chunk of input) {
                assertArtifactReadActive(signal);
                // writeFile completes the entire supplied chunk at the current
                // descriptor offset. Only this owner closes either descriptor.
                await destination.writeFile(chunk);
                hash.update(chunk);
                assertArtifactReadActive(signal);
              }
              const after = await source.stat({ bigint: true });
              if (after.size > BigInt(companion.memberSizeBytes))
                throw new AnalysisArtifactChangedError(
                  "open_binary",
                  companion.memberPath,
                  `The dSYM DWARF member grew beyond its admitted size (${String(companion.memberSizeBytes)} bytes)`,
                );
              const observed = hash.digest("hex");
              if (
                observed !== companion.memberSha256 ||
                !sameRegularFileState(initial, after)
              )
                throw new AnalysisArtifactChangedError(
                  "open_binary",
                  companion.memberPath,
                  `dSYM member digest mismatch: expected ${companion.memberSha256}, observed ${observed}`,
                );
              assertArtifactReadActive(signal);
              return {
                dsym: {
                  source_path: companion.sourcePath,
                  member_sha256: companion.memberSha256,
                  uuid: companion.uuid,
                  staged_member: stagedMember,
                },
              };
            },
          );
        },
        "follow",
      ),
    );
  } catch (cause: unknown) {
    // Both descriptors have settled, or transferred their failed-close owners
    // to the resource scope, before the partial staged tree is removed.
    await rm(stagedBundle, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw mapArtifactFileFailure(cause, classifyStagingFailure(companion));
  }
};

/** Name the admitted member, not a raw errno, when it vanished after admission. */
const classifyStagingFailure =
  (companion: MachODebugCompanion) =>
  (cause: unknown): unknown => {
    if (cause instanceof NonRegularFileReadError)
      return new AnalysisArtifactChangedError(
        "open_binary",
        companion.memberPath,
        "The admitted dSYM DWARF member is no longer a regular file",
        { cause },
      );
    if (!(cause instanceof Error) || !("code" in cause)) return cause;
    const path =
      "path" in cause && typeof cause.path === "string"
        ? cause.path
        : companion.memberPath;
    if (path !== companion.memberPath) return cause;
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError("open_binary", path, cause.code, {
        cause,
      });
    if (
      cause.code === "ENOENT" ||
      cause.code === "ENOTDIR" ||
      cause.code === "ELOOP"
    )
      return new AnalysisArtifactChangedError(
        "open_binary",
        path,
        `The admitted dSYM DWARF member is no longer readable (${cause.code})`,
        { cause },
      );
    return cause;
  };
