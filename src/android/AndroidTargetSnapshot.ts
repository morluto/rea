import { constants, createReadStream } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";

/** Stream a local file digest without retaining the APK or JAR in memory. */
export const hashAndroidFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/** Bind decompiler input to the admitted artifact, even if the original changes. */
export const snapshotAndroidTarget = async (
  path: string,
  sha256: string,
  root: string,
  operation: AndroidOperation,
): Promise<string> => {
  const snapshot = join(root, "target.apk");
  await copyFile(path, snapshot, constants.COPYFILE_EXCL);
  await chmod(snapshot, 0o400);
  if ((await hashAndroidFile(snapshot)) !== sha256)
    throw new AnalysisInputError(operation, undefined, [
      {
        path: ["path"],
        reason: "invalid_value",
        message:
          "APK bytes changed after admission; retry against a stable file.",
      },
    ]);
  return snapshot;
};

/** Fingerprint the actual immutable engine bytes executed for this observation. */
export const snapshotAndroidEngine = async (
  source: string,
  root: string,
): Promise<{ path: string; sha256: string }> => {
  const path = join(root, "engine.jar");
  await copyFile(source, path, constants.COPYFILE_EXCL);
  await chmod(path, 0o400);
  return { path, sha256: await hashAndroidFile(path) };
};
