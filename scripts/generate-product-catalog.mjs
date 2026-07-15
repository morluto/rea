import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureGeneratedFile } from "./lib/generated-file.mjs";
import {
  createProductCatalog,
  serializeProductCatalog,
} from "./lib/product-catalog.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown product catalog option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = await createProductCatalog(root);
await ensureGeneratedFile({
  path: join(root, "docs/product-catalog.json"),
  source: await serializeProductCatalog(catalog),
  check: arguments_.has("--check"),
  generateCommand: "npm run docs:generate",
});
