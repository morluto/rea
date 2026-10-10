import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  openRegularFile,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import type { GhidraInstallationInspection } from "./GhidraInstallation.js";

/** Installed processor code and data, distinct from REA's analysis-extension ABI. */
export const ghidraPspExtensionSchema = z.strictObject({
  id: z.literal("ghidra-allegrex"),
  root: z.string().refine(isAbsolute),
  ghidra_version: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type GhidraPspExtension = z.infer<typeof ghidraPspExtensionSchema>;

// Resource bounds for scanning a caller-installed extension, not target limits.
const MAX_ENTRIES = 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 16;
const REQUIRED = [
  "Module.manifest",
  "extension.properties",
  "data/languages/allegrex.ldefs",
  "data/languages/allegrex.sla",
  "data/languages/allegrex.pspec",
  "data/languages/allegrex.cspec",
];

/** Read-only fingerprint of all installed files; no home scanning or installation. */
export const inspectGhidraPspExtension = async (
  root: string,
  ghidraVersion: string,
  signal?: AbortSignal,
): Promise<GhidraPspExtension> => {
  signal?.throwIfAborted();
  if (!isAbsolute(root) || (await realpath(root)) !== root)
    throw new Error(
      "The installed Allegrex directory must be a canonical non-symlink path.",
    );
  const files: string[] = [];
  let entries = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    entries++;
    if (entries > MAX_ENTRIES)
      throw new Error(
        "Allegrex extension inventory exceeds the inspection limit.",
      );
    if (depth > MAX_DEPTH)
      throw new Error(
        "Allegrex extension directory nesting exceeds the inspection limit.",
      );
    const path = join(root, relative);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      const children = await readdir(path);
      children.sort();
      if (children.length > MAX_ENTRIES)
        throw new Error(
          "Allegrex extension inventory exceeds the inspection limit.",
        );
      for (const child of children)
        await visit(
          relative === "" ? child : `${relative}/${child}`,
          depth + 1,
        );
    } else if (metadata.isFile()) {
      files.push(relative);
      if (files.length > MAX_ENTRIES)
        throw new Error(
          "Allegrex extension inventory exceeds the inspection limit.",
        );
    } else
      throw new Error(
        `Allegrex extension entries must be regular files or directories: ${relative}`,
      );
  };
  await visit("", 0);
  for (const required of REQUIRED)
    if (!files.includes(required))
      throw new Error(`Missing installed Allegrex component: ${required}`);
  if (!files.some((path) => path.startsWith("lib/") && path.endsWith(".jar")))
    throw new Error("The installed Allegrex extension has no loader JAR.");
  const hash = createHash("sha256");
  let bytesRead = 0;
  let properties = "";
  for (const relative of files) {
    signal?.throwIfAborted();
    const path = join(root, relative);
    const handle = await openRegularFile(path, { symlinks: "reject", signal });
    try {
      const before = await handle.stat();
      if (
        !Number.isSafeInteger(before.size) ||
        before.size > MAX_BYTES - bytesRead
      )
        throw new Error(
          "Allegrex extension bytes exceed the inspection limit.",
        );
      if (relative === "extension.properties" && before.size > 65536)
        throw new Error(
          "Allegrex extension properties exceed the inspection limit.",
        );
      hash.update(JSON.stringify([relative, before.size]));
      const buffer = Buffer.alloc(Math.min(65536, before.size + 1));
      let offset = 0;
      const chunks: Buffer[] = [];
      while (offset < before.size) {
        signal?.throwIfAborted();
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (read.bytesRead === 0)
          throw new Error(`Truncated Allegrex component: ${relative}`);
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk);
        if (relative === "extension.properties")
          chunks.push(Buffer.from(chunk));
        offset += read.bytesRead;
      }
      if (
        !sameRegularFileState(before, await handle.stat()) ||
        !sameRegularFileState(before, await lstat(path))
      )
        throw new Error(
          `Allegrex component changed during inspection: ${relative}`,
        );
      bytesRead += before.size;
      if (relative === "extension.properties")
        properties = Buffer.concat(chunks).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  // Ghidra's extension.properties version is the compatible Ghidra version,
  // not the extension release (e.g. v21.4); content identity supplies the latter.
  const property = (name: string): string => {
    const values = properties.split(/\r?\n/u).flatMap((line) => {
      const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*?)\s*$/u.exec(line);
      return match?.[1] === name ? [match[2] ?? ""] : [];
    });
    if (values.length !== 1)
      throw new Error(`Allegrex extension must declare exactly one ${name}.`);
    return values[0] ?? "";
  };
  if (
    property("name") !== "ghidra-allegrex" ||
    property("version") !== ghidraVersion
  )
    throw new Error(
      `Allegrex extension metadata does not match the selected Ghidra ${ghidraVersion}; install or rebuild a compatible extension.`,
    );
  signal?.throwIfAborted();
  return {
    id: "ghidra-allegrex",
    root,
    ghidra_version: ghidraVersion,
    sha256: hash.digest("hex"),
  };
};

/** Resolve prerequisites before opening or admitting cached PSP analysis. */
export const resolveGhidraPspExtension = async (
  installation: GhidraInstallationInspection,
  signal?: AbortSignal,
): Promise<Result<GhidraPspExtension, AnalysisError>> => {
  if (signal?.aborted)
    return err(new AnalysisCancelledError("resolve_analysis_profile"));
  try {
    if (
      installation.status !== "available" ||
      installation.platform !== "linux" ||
      installation.architecture !== "x64"
    )
      throw new Error(
        "The initial PSP profile requires a supported Linux x64 Ghidra installation.",
      );
    const root = join(
      await realpath(installation.installDir),
      "Ghidra",
      "Extensions",
      "ghidra-allegrex",
    );
    return ok(
      await inspectGhidraPspExtension(
        root,
        installation.providerVersion,
        signal,
      ),
    );
  } catch (cause: unknown) {
    if (signal?.aborted)
      return err(new AnalysisCancelledError("resolve_analysis_profile"));
    const reason = `PSP_EXTENSION_UNAVAILABLE: ${cause instanceof Error ? cause.message : String(cause)} Use a compatible caller-installed ghidra-allegrex under GHIDRA_INSTALL_DIR/Ghidra/Extensions; REA does not install it.`;
    return err(
      new AnalysisCapabilityUnavailableError(
        "ghidra",
        "resolve_analysis_profile",
        reason,
        { cause, userMessage: reason },
      ),
    );
  }
};
