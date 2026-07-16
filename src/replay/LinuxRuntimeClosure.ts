import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";

import type { ReplayRuntimeFileIdentity } from "../application/JavaScriptReplayPlanning.js";

const LDD_OUTPUT_LIMIT = 64 * 1024;

/** Resolve and content-address the exact ELF closure mounted into a replay. */
export const resolveLinuxRuntimeClosure = async (
  nodePath: string,
): Promise<readonly ReplayRuntimeFileIdentity[]> => {
  const canonicalNode = await realpath(nodePath);
  const collected = await collectLdd(canonicalNode);
  if (collected.code !== 0)
    throw new TypeError(
      "Node runtime dependency closure could not be resolved",
    );
  const paths = [...collected.stdout.matchAll(/(?:=>\s+)?(\/[^\s()]+)/gu)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  const libraries = await Promise.all(
    [...new Set(paths)].map(async (path) => {
      const sourcePath = await realpath(path);
      return identity(sourcePath, path);
    }),
  );
  return [await identity(canonicalNode, "/runtime/node"), ...libraries];
};

const identity = async (
  sourcePath: string,
  destinationPath: string,
): Promise<ReplayRuntimeFileIdentity> => ({
  sourcePath,
  destinationPath,
  sha256: createHash("sha256")
    .update(await readFile(sourcePath))
    .digest("hex"),
});

const collectLdd = async (
  path: string,
): Promise<{ readonly code: number | null; readonly stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/ldd", [path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    timeout.unref();
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = Math.max(
        0,
        LDD_OUTPUT_LIMIT - Buffer.byteLength(stdout),
      );
      stdout += chunk.subarray(0, remaining).toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout });
    });
  });
