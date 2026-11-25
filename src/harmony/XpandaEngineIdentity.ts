import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { XPANDA_LIMITS } from "./XpandaRelease.js";
import { errorMessage } from "../kernel/errorMessage.js";

export interface XpandaEngineIdentity {
  /** Digest over the checkout's package.json and src tree, path-framed. */
  readonly sha256: string;
  readonly files: number;
  readonly bytes: number;
}

export class XpandaEngineScanError extends Error {
  constructor(
    message: string,
    readonly code: "too_many_files" | "too_many_bytes" | "unreadable",
  ) {
    super(message);
    this.name = "XpandaEngineScanError";
  }
}

const digestOf = async (
  root: string,
  relativePaths: readonly string[],
  limits: { readonly files: number; readonly bytes: number },
): Promise<XpandaEngineIdentity> => {
  const hash = createHash("sha256");
  let bytes = 0;
  hash.update("files " + String(relativePaths.length) + "\0");
  for (const relativePath of relativePaths) {
    const content = await readFile(join(root, relativePath)).catch(
      (cause: unknown) => {
        throw new XpandaEngineScanError(
          `The configured xpanda checkout could not be read at ${relativePath}: ${errorMessage(cause)}`,
          "unreadable",
        );
      },
    );
    bytes += content.byteLength;
    if (bytes > limits.bytes)
      throw new XpandaEngineScanError(
        `The configured xpanda checkout's src tree exceeds the ${String(limits.bytes)}-byte engine scan bound`,
        "too_many_bytes",
      );
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return {
    sha256: hash.digest("hex"),
    files: relativePaths.length,
    bytes,
  };
};

/** List the engine source tree depth-first, then sort for a stable digest. */
const collectSourcePaths = async (
  root: string,
  limits: { readonly files: number; readonly bytes: number },
): Promise<readonly string[]> => {
  const paths: string[] = ["package.json"];
  const walk = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(root, relativeDirectory), {
      withFileTypes: true,
    }).catch((cause: unknown) => {
      throw new XpandaEngineScanError(
        `The configured xpanda checkout could not be read at ${relativeDirectory}: ${errorMessage(cause)}`,
        "unreadable",
      );
    });
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relativePath);
      else if (entry.isFile()) {
        paths.push(relativePath);
        if (paths.length > limits.files)
          throw new XpandaEngineScanError(
            `The configured xpanda checkout's src tree exceeds the ${String(limits.files)}-file engine scan bound`,
            "too_many_files",
          );
      }
    }
  };
  await walk("src");
  return paths.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
};

/**
 * Digest the engine code that will answer operations: the checkout's
 * package.json plus its whole src tree. Loaders, dependencies and the Node
 * runtime are intentionally outside this identity and stay unattested.
 */
export const hashXpandaEngine = async (
  root: string,
): Promise<XpandaEngineIdentity> => {
  const limits = {
    files: XPANDA_LIMITS.engineFiles,
    bytes: XPANDA_LIMITS.engineBytes,
  };
  return digestOf(root, await collectSourcePaths(root, limits), limits);
};
