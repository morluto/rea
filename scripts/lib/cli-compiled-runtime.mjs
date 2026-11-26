import { access } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * @param {string} packageRoot
 * @param {readonly string[]} paths
 */
export async function compiledRuntimeExists(packageRoot, paths) {
  for (const path of paths) {
    try {
      await access(resolve(packageRoot, path));
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      )
        return false;
      throw cause;
    }
  }
  return true;
}

/** @param {string} packageRoot */
export const missingCompiledRuntimeMessage = (packageRoot) =>
  `REA's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot} to install dependencies and build REA, then restart it. If this is an installed package, reinstall rea-agents.\n`;
