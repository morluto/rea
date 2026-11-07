import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, it } from "vitest";
import {
  artifactFormatMetadataSchema,
  COMPARED_FORMAT_METADATA_KINDS,
} from "../../src/domain/artifactFormatMetadata.js";

const FORMAT_METADATA_KINDS = new Set<string>(
  artifactFormatMetadataSchema.options.map((option) => option.shape.kind.value),
);
// Markers, not the paragraph's wording, delimit the contract's compared kinds.
const BEGIN = "<!-- BEGIN:compare-artifacts:compared-format-metadata-kinds -->";
const END = "<!-- END:compare-artifacts:compared-format-metadata-kinds -->";

it("names exactly the format metadata kinds that artifact comparison compares", async () => {
  const contracts = await readFile(resolve("docs/mcp-contracts.md"), "utf8");
  const start = contracts.indexOf(BEGIN);
  const end = contracts.indexOf(END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(contracts.indexOf(BEGIN, start + 1)).toBe(-1);
  expect(contracts.indexOf(END, end + 1)).toBe(-1);
  const named = [
    ...contracts.slice(start + BEGIN.length, end).matchAll(/`([^`]+)`/gu),
  ]
    .map((match) => match[1] ?? "")
    .filter((token) => FORMAT_METADATA_KINDS.has(token));
  expect(new Set(named)).toEqual(new Set(COMPARED_FORMAT_METADATA_KINDS));
});
