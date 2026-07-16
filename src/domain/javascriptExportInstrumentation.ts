import { createHash } from "node:crypto";

import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const javascriptExportInstrumentationInputSchema = z.strictObject({
  artifact_path: z.string().min(1).max(4_096),
  artifact_sha256: digestSchema,
  selection: z.strictObject({
    byte_start: z.number().int().min(0),
    byte_end: z.number().int().min(1),
    selected_sha256: digestSchema,
    export_name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,199}$/u),
  }),
});

export const javascriptExportTransformationManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal("commonjs-factory-export-v1"),
  artifact_path: z.string().min(1).max(4_096),
  original_sha256: digestSchema,
  original_byte_length: z.number().int().min(0),
  instrumented_sha256: digestSchema,
  instrumented_byte_length: z.number().int().min(0),
  selected_range: z.strictObject({
    byte_start: z.number().int().min(0),
    byte_end: z.number().int().min(1),
    selected_sha256: digestSchema,
  }),
  inserted_ranges: z
    .array(
      z.strictObject({
        byte_start: z.number().int().min(0),
        byte_end: z.number().int().min(1),
        inserted_sha256: digestSchema,
        purpose: z.enum(["factory-prefix", "export-binding", "factory-suffix"]),
      }),
    )
    .length(3),
  output_format: z.literal("commonjs-factory"),
  source_map: z.literal(null),
});

export interface JavaScriptExportInstrumentation {
  readonly bytes: Uint8Array;
  readonly manifest: z.infer<
    typeof javascriptExportTransformationManifestSchema
  >;
}

/** Instrument one exact UTF-8 expression range without mutating source bytes. */
export const instrumentJavaScriptExport = (
  source: Uint8Array,
  rawInput: unknown,
): JavaScriptExportInstrumentation => {
  const input = javascriptExportInstrumentationInputSchema.parse(rawInput);
  if (sha256(source) !== input.artifact_sha256)
    throw new TypeError("JavaScript instrumentation artifact digest mismatch");
  const { byte_start: start, byte_end: end } = input.selection;
  if (end <= start || end > source.byteLength)
    throw new TypeError(
      "JavaScript instrumentation selection is out of bounds",
    );
  const selected = source.slice(start, end);
  if (sha256(selected) !== input.selection.selected_sha256)
    throw new TypeError("JavaScript instrumentation selection digest mismatch");
  decodeUtf8(source);
  decodeUtf8(selected);

  const prefix = encode("function(module, exports, require) {\n");
  const binding = encode(
    `\nmodule.exports[${JSON.stringify(input.selection.export_name)}] = (${decodeUtf8(selected)});\n`,
  );
  const suffix = encode("}\n");
  const bytes = concatenate([prefix, source, binding, suffix]);
  const bindingStart = prefix.byteLength + source.byteLength;
  const suffixStart = bindingStart + binding.byteLength;
  const manifest = javascriptExportTransformationManifestSchema.parse({
    schema_version: 1,
    kind: "commonjs-factory-export-v1",
    artifact_path: input.artifact_path,
    original_sha256: input.artifact_sha256,
    original_byte_length: source.byteLength,
    instrumented_sha256: sha256(bytes),
    instrumented_byte_length: bytes.byteLength,
    selected_range: {
      byte_start: start,
      byte_end: end,
      selected_sha256: input.selection.selected_sha256,
    },
    inserted_ranges: [
      range(0, prefix, "factory-prefix"),
      range(bindingStart, binding, "export-binding"),
      range(suffixStart, suffix, "factory-suffix"),
    ],
    output_format: "commonjs-factory",
    source_map: null,
  });
  return { bytes, manifest };
};

const range = (
  start: number,
  bytes: Uint8Array,
  purpose: "factory-prefix" | "export-binding" | "factory-suffix",
) => ({
  byte_start: start,
  byte_end: start + bytes.byteLength,
  inserted_sha256: sha256(bytes),
  purpose,
});

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const decodeUtf8 = (value: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(value);

const concatenate = (values: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(
    values.reduce((total, value) => total + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
};

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
