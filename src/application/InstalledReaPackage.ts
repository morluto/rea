import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";

/** REA's manifest is tens of kilobytes; a larger file is not one REA published. */
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;

/** The manifest fields that name REA's package and the script its CLI runs. */
const reaPackageManifestSchema = z.object({
  name: z.literal(PRODUCT_IDENTITY.packageName),
  bin: z.object({ [PRODUCT_IDENTITY.cliBinary]: z.string() }),
});

/**
 * Whether a path resolves to the CLI script of an installed REA package.
 * npm, npx, pnpm and Bun place an installed package at `node_modules/<name>`,
 * and its manifest names the script REA's CLI runs. A source checkout or an
 * entry whose package is gone is not proven to be another REA installation.
 */
export const installedReaPackageEntrypoint = (path: string): boolean => {
  try {
    const script = realpathSync.native(path);
    // Every published manifest maps the CLI to `scripts/rea.mjs`.
    const root = dirname(dirname(script));
    if (
      basename(root) !== PRODUCT_IDENTITY.packageName ||
      basename(dirname(root)) !== "node_modules"
    )
      return false;
    const manifestPath = join(root, "package.json");
    const stat = statSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_MANIFEST_BYTES) return false;
    const manifest = reaPackageManifestSchema.safeParse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    return (
      manifest.success &&
      resolve(root, manifest.data.bin[PRODUCT_IDENTITY.cliBinary]) === script
    );
  } catch {
    return false;
  }
};
