import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { isEnoentError } from "./ClientConfigPath.js";

/** REA's manifest is tens of kilobytes; a larger file is not one REA published. */
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;

/** The manifest fields that name REA's package and the script its CLI runs. */
const reaPackageManifestSchema = z.object({
  name: z.literal(PRODUCT_IDENTITY.packageName),
  bin: z.object({ [PRODUCT_IDENTITY.cliBinary]: z.string() }),
});

/**
 * Whether a launcher script belongs to an installed REA package: verified,
 * absent (another package or location, or no manifest), or unknown when the
 * script does not resolve, the package layout matches but its manifest could
 * not be read or parsed, or the runtimes may select different scripts.
 */
export type InstalledReaPackageEvidence = "verified" | "absent" | "unknown";

/** Classify one resolved script against the package directory that contains it. */
const scriptPackageEvidence = (script: string): InstalledReaPackageEvidence => {
  // Every published manifest maps the CLI to `scripts/rea.mjs`, and npm, npx,
  // pnpm and Bun place an installed package at `node_modules/<name>`.
  const root = dirname(dirname(script));
  if (
    basename(root) !== PRODUCT_IDENTITY.packageName ||
    basename(dirname(root)) !== "node_modules"
  )
    return "absent";
  const manifestPath = join(root, "package.json");
  let value: unknown;
  try {
    const stat = statSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_MANIFEST_BYTES)
      return "absent";
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    // No manifest means no installed package claims the script; one that
    // cannot be read or parsed leaves the package unresolved.
    return isEnoentError(cause) ? "absent" : "unknown";
  }
  const manifest = reaPackageManifestSchema.safeParse(value);
  return manifest.success &&
    resolve(root, manifest.data.bin[PRODUCT_IDENTITY.cliBinary]) === script
    ? "verified"
    : "absent";
};

const resolvedScript = (path: string): string | undefined => {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
};

/**
 * Whether a launcher path selects the CLI script of an installed REA package.
 * Node removes `..` before following links, while native traversal follows
 * them first; when the two select different files and either may be REA's,
 * the selected script is unknown.
 */
export const installedReaPackageEvidence = (
  path: string,
): InstalledReaPackageEvidence => {
  const selections = [
    ...new Set([resolvedScript(path), resolvedScript(resolve(path))]),
  ];
  // A script that does not resolve may be a removed REA installation.
  const evidence = selections.map((script) =>
    script === undefined ? "unknown" : scriptPackageEvidence(script),
  );
  if (evidence.length === 1) return evidence[0] ?? "unknown";
  return evidence.every((value) => value === "absent") ? "absent" : "unknown";
};
