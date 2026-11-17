import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { syncCursorPluginSkill } from "./lib/cursor-plugin-bundle.mjs";
import { assertDocumentationFacts } from "./lib/docs-facts.mjs";
import { ensureGeneratedFile } from "./lib/generated-file.mjs";
import {
  createProductCatalog,
  serializeProductCatalog,
} from "./lib/product-catalog.mjs";

const exec = promisify(execFile);
const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--built")
    throw new Error(`Unknown documentation check option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!arguments_.has("--built")) {
  await assertDocumentationFacts(root, await createProductCatalog(root));
} else {
  /** @param {string} script */
  const runCheckScript = async (script) => {
    try {
      await exec(process.execPath, [join(root, script), "--check"], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (cause) {
      if (cause && typeof cause === "object") {
        if (
          "stdout" in cause &&
          typeof cause.stdout === "string" &&
          cause.stdout
        )
          process.stderr.write(cause.stdout);
        if (
          "stderr" in cause &&
          typeof cause.stderr === "string" &&
          cause.stderr
        )
          process.stderr.write(cause.stderr);
      }
      throw cause;
    }
  };
  const catalogPromise = createProductCatalog(root);
  await Promise.all([
    catalogPromise.then((catalog) => assertDocumentationFacts(root, catalog)),
    catalogPromise.then(async (catalog) =>
      ensureGeneratedFile({
        path: join(root, "docs/public/product-catalog.json"),
        source: await serializeProductCatalog(catalog),
        check: true,
        generateCommand: "npm run docs:generate",
      }),
    ),
    syncCursorPluginSkill({ root, check: true }),
    runCheckScript("scripts/generate-package-metadata.mjs"),
    runCheckScript("scripts/generate-skill-metadata.mjs"),
    runCheckScript("scripts/generate-completion-ledger.mjs"),
    runCheckScript("scripts/generate-error-schema.mjs"),
    runCheckScript("scripts/generate-third-party-inventory.mjs"),
  ]);
}
