import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { JsonValue } from "../domain/jsonValue.js";
import { AnalysisArtifactChangedError } from "../domain/analysisErrorCore.js";
import type { MachODebugCompanion } from "../domain/binaryTargetTypes.js";

/**
 * Stage an admitted dSYM companion beside the private target snapshot.
 *
 * Ghidra's DSymSectionProvider looks up external DWARF by strict file naming:
 * `<snapshot directory>/<snapshot name>.dSYM/Contents/Resources/DWARF/<snapshot
 * name>`. The staged DWARF member is therefore copied under the snapshot's
 * name; the caller's bundle on disk is never modified.
 */
export const stageGhidraDebugCompanion = async (
  companion: MachODebugCompanion,
  runtimeRoot: string,
  snapshotPath: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<JsonValue> => {
  const snapshotName = basename(snapshotPath);
  const memberName = join(
    runtimeRoot,
    `${snapshotName}.dSYM`,
    "Contents",
    "Resources",
    "DWARF",
    snapshotName,
  );
  await mkdir(join(memberName, ".."), { recursive: true });
  let source;
  let destination;
  try {
    // A path replaced by a FIFO must not block startup before its type is
    // checked, mirroring the snapshot admission's source open. A member that
    // disappeared after admission is a changed artifact, not an open failure.
    try {
      source = await open(
        companion.memberPath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
    } catch {
      throw new AnalysisArtifactChangedError(
        "open_binary",
        companion.memberPath,
        "The admitted dSYM DWARF member is no longer readable",
      );
    }
    if (!(await source.stat()).isFile())
      throw new AnalysisArtifactChangedError(
        "open_binary",
        companion.memberPath,
        "The admitted dSYM DWARF member is no longer a regular file",
      );
    destination = await open(memberName, "wx", 0o600);
    await destination.chmod(0o600);
    const hash = createHash("sha256");
    // The admitted size bounds the staged copy: a member replaced or grown
    // after admission must not stream past the budget that admitted it.
    let staged = 0;
    const digest = new Transform({
      transform(chunk: unknown, _encoding, done) {
        if (!Buffer.isBuffer(chunk)) {
          done(new TypeError("dSYM member stream must contain bytes"));
          return;
        }
        staged += chunk.length;
        if (staged > companion.memberSizeBytes) {
          done(
            new AnalysisArtifactChangedError(
              "open_binary",
              companion.memberPath,
              `The dSYM DWARF member grew beyond its admitted size (${String(companion.memberSizeBytes)} bytes)`,
            ),
          );
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      source.createReadStream(),
      digest,
      destination.createWriteStream(),
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const observedSha256 = hash.digest("hex");
    if (observedSha256 !== companion.memberSha256)
      throw new AnalysisArtifactChangedError(
        "open_binary",
        companion.memberPath,
        `dSYM member digest mismatch: expected ${companion.memberSha256}, observed ${observedSha256}`,
      );
    return {
      dsym: {
        source_path: companion.sourcePath,
        member_sha256: companion.memberSha256,
        uuid: companion.uuid,
        staged_member: memberName,
      },
    };
  } catch (cause: unknown) {
    await rm(join(runtimeRoot, `${snapshotName}.dSYM`), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    throw cause;
  } finally {
    await Promise.all([source?.close(), destination?.close()]);
  }
};
