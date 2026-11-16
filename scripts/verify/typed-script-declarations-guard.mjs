import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Find sibling `.d.mts` or `.d.ts` declaration files alongside `.mjs` or `.js`
 * scripts covered by `tsconfig.scripts.json`.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export const findTypedScriptSiblingDeclarations = async (root) => {
  const scriptsTsconfig =
    /** @type {{ readonly files?: readonly unknown[] }} */ (
      JSON.parse(await readFile(join(root, "tsconfig.scripts.json"), "utf8"))
    );
  /** @type {string[]} */
  const siblingDeclarationFiles = [];
  for (const scriptPath of scriptsTsconfig.files ?? []) {
    if (typeof scriptPath !== "string") continue;
    for (const suffix of [".d.mts", ".d.ts"]) {
      /** @type {string} */
      const declarationPath = scriptPath.replace(/\.(?:mjs|js)$/u, suffix);
      if (declarationPath === scriptPath) continue;
      try {
        await access(join(root, declarationPath));
        siblingDeclarationFiles.push(declarationPath);
      } catch {
        // No sibling declaration file.
      }
    }
  }
  return siblingDeclarationFiles;
};
