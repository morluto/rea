import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { open, unlink } from "node:fs/promises";

import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import { ghidraSessionRoot } from "./GhidraSessionRoot.js";

/**
 * Remediation for a host that denies writes under the session temporary root.
 * It states only what REA observed; it does not name an antivirus product or
 * REA's own private-directory ACL as the cause.
 */
export const GHIDRA_RESTRICTED_TEMP_REMEDIATION =
  "REA places each Ghidra session's private runtime under the Ghidra session root: os.tmpdir(), which follows TMP/TEMP on Windows, or, when that path has a dot-prefixed element that Ghidra rejects, its nearest ancestor without one. On a restricted or sandboxed host that denies child-process writes outside an allowed tree, set TMP and TEMP to a directory inside that allowed tree whose path has no dot-prefixed element, in the environment that starts REA (your shell or the MCP client's registration), restart REA, and retry. Ghidra's LaunchSupport rewrites java_home.save, so creating that file in advance does not help.";

/** Outcome of one write-and-delete probe of the session temporary root. */
export type GhidraTemporaryDirectoryProbe =
  | { readonly ok: true; readonly directory: string }
  | {
      readonly ok: false;
      readonly directory: string;
      /** Whether creating/writing the file or removing it failed. */
      readonly stage: "write" | "cleanup";
      /** Node system code such as EACCES or EPERM, when reported. */
      readonly code: string | undefined;
      readonly message: string;
      /** Probe file whose removal failed; its cleanup owner is retained. */
      readonly retainedPath?: string;
    };

/** Filesystem seam so classification is testable without a restricted host. */
export interface GhidraTemporaryDirectoryHost {
  readonly sessionRoot: () => string;
  readonly writeProbe: (path: string) => Promise<void>;
  readonly removeProbe: (path: string) => Promise<void>;
}

const systemHost: GhidraTemporaryDirectoryHost = {
  sessionRoot: () => ghidraSessionRoot(),
  writeProbe: async (path) => {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile("rea doctor probe\n");
    } finally {
      await handle.close();
    }
  },
  removeProbe: unlink,
};

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Create and delete one file under the Ghidra session root from the REA
 * process. This proves only that REA itself can use the root; a host that
 * restricts child processes separately is not detected here and is classified
 * from the child's own failure output instead. A probe file that cannot be
 * removed stays owned by `resourceOwner`, whose close retries the removal.
 */
export const probeGhidraTemporaryDirectory = async (
  resourceOwner: RetainedResourceScope,
  overrides: Partial<GhidraTemporaryDirectoryHost> = {},
): Promise<GhidraTemporaryDirectoryProbe> => {
  const host = { ...systemHost, ...overrides };
  const directory = host.sessionRoot();
  const path = join(directory, `rea-doctor-probe-${randomUUID()}`);
  const remove = () =>
    host.removeProbe(path).catch((cause: unknown) => {
      if (errorCode(cause) !== "ENOENT") throw cause;
    });
  const retain = () =>
    resourceOwner.retain({ close: remove, cleanupResources: [path] }, path);
  try {
    await host.writeProbe(path);
  } catch (cause: unknown) {
    // A failed write may still have created the entry; try to remove it.
    const removed = await remove().then(
      () => true,
      () => false,
    );
    if (!removed) retain();
    return {
      ok: false,
      directory,
      stage: "write",
      code: errorCode(cause),
      message: errorMessage(cause),
      ...(removed ? {} : { retainedPath: path }),
    };
  }
  try {
    await host.removeProbe(path);
  } catch (cause: unknown) {
    retain();
    return {
      ok: false,
      directory,
      stage: "cleanup",
      code: errorCode(cause),
      message: errorMessage(cause),
      retainedPath: path,
    };
  }
  return { ok: true, directory };
};

/** A denied `java_home.save` write reported in Ghidra launcher output. */
export interface GhidraJavaHomeSaveDenial {
  readonly path: string;
}

const JAVA_HOME_SAVE_DENIED =
  /FileNotFoundException:\s*(.*?java_home\.save)\s*\(Access is denied\)/iu;

/**
 * Recognize the JVM's access-denied refusal to open `java_home.save` (Win32
 * error 5). Only a line naming that file and the denial counts; other output,
 * including other denied paths, is not classified.
 */
export const ghidraJavaHomeSaveDenial = (
  text: readonly string[],
): GhidraJavaHomeSaveDenial | undefined => {
  for (const block of text)
    for (const line of block.split(/\r?\n/u)) {
      const path = JAVA_HOME_SAVE_DENIED.exec(line)?.[1]?.trim();
      if (path !== undefined && path !== "") return { path };
    }
  return undefined;
};
