import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analysisErrorJsonSchema } from "../dist/contracts/analysisErrorJsonSchema.js";
import { analysisErrorCatalogue } from "../dist/domain/analysisErrorClassification.js";
import { hopperErrorCatalogue } from "../dist/hopper/HopperErrors.js";
import { formatGeneratedFile } from "./lib/format-generated-file.mjs";
import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown error schema option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = arguments_.has("--check");
await ensureGeneratedFile({
  path: join(root, "docs/error-contract.schema.json"),
  source: await formatGeneratedFile(
    "docs/error-contract.schema.json",
    JSON.stringify(analysisErrorJsonSchema),
  ),
  check,
  generateCommand: "npm run docs:generate",
});

/** RFC 4180 field: quoted only when it contains a delimiter, quote or newline. */
const csvField = (value) => {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const columns = {
  tag: "tag",
  discriminant: "discriminant",
  code: "code",
  category: "category",
  retryable_by_default: "retryableByDefault",
};
await ensureGeneratedFile({
  path: join(root, "docs/user-visible-errors.csv"),
  source: [
    Object.keys(columns).join(","),
    // Provider-owned errors present themselves; their providers list their rows.
    ...[...analysisErrorCatalogue(), ...hopperErrorCatalogue()].map((entry) =>
      Object.values(columns)
        .map((field) => csvField(entry[field]))
        .join(","),
    ),
    "",
  ].join("\n"),
  check,
  generateCommand: "npm run docs:generate",
});
