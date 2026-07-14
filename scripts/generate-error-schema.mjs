import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analysisErrorJsonSchema } from "../dist/contracts/errorSchemas.js";
import { format } from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await writeFile(
  join(root, "docs/error-contract.schema.json"),
  await format(JSON.stringify(analysisErrorJsonSchema), { parser: "json" }),
  "utf8",
);
