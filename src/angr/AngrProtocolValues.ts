import { z } from "zod";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

/** Canonical lowercase `0x` hexadecimal address as angr reports it. */
export const angrAddressSchema = z
  .string()
  .regex(/^(?:0x)?[0-9a-f]+$/iu)
  .transform(
    (value) =>
      `0x${BigInt(value.startsWith("0x") || value.startsWith("0X") ? value : `0x${value}`).toString(16)}`,
  );

/** REA header architectures as archinfo identifiers; raw images are little-endian like Ghidra's import. */
const ARCHINFO_IDS: Readonly<Record<string, string>> = {
  x86: "x86",
  x86_64: "x86_64",
  arm: "armel",
  arm64: "aarch64",
};

/** Loader options for targets angr cannot identify unaided; empty for headered files. */
export const angrLoadOptions = (
  target: BinaryTarget,
): Readonly<Record<string, string>> => {
  if (target.kind !== "executable") return {};
  const arch = ARCHINFO_IDS[target.architecture];
  if (target.format === "mach-o-universal")
    return arch === undefined ? {} : { arch };
  if (target.format === "raw-binary" && arch !== undefined)
    // REA maps the whole file from the entry point, so the image base is the entry.
    return {
      backend: "blob",
      arch,
      base_address: target.entryPoint,
      entry_point: target.entryPoint,
    };
  return {};
};

export const loadBinarySchema = z
  .object({
    project_id: z.string().min(1),
    binary_path: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu)
      .optional(),
    arch: z.string(),
    bits: z.number().int(),
    endianness: z.string(),
    entry_point: angrAddressSchema,
    filename: z.string(),
  })
  .passthrough();
export type AngrLoadedBinary = z.infer<typeof loadBinarySchema>;

export const cfgStatsSchema = z
  .object({
    project_id: z.string(),
    status: z.literal("success"),
    nodes: z.number().int().min(0),
    edges: z.number().int().min(0),
    functions_discovered: z.number().int().min(0),
  })
  .passthrough();

export const functionSummarySchema = z
  .object({
    address: angrAddressSchema,
    name: z.string(),
    is_plt: z.boolean(),
    is_syscall: z.boolean(),
  })
  .passthrough();
export type AngrFunctionSummary = z.infer<typeof functionSummarySchema>;

export const functionPageSchema = z
  .object({
    total: z.number().int().min(0),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    functions: z.array(functionSummarySchema),
  })
  .passthrough();

export const functionInfoSchema = z
  .object({
    address: angrAddressSchema,
    name: z.string(),
    size: z.number().int().min(0).nullable(),
    is_plt: z.boolean(),
    is_syscall: z.boolean(),
    is_simprocedure: z.boolean(),
    returning: z.boolean().nullable(),
    binary_name: z.string().nullable(),
    num_blocks: z.number().int().min(0),
    prototype: z.string().optional(),
  })
  .passthrough();
export type AngrFunction = z.infer<typeof functionInfoSchema>;

export const decompileSchema = z
  .object({
    function_address: angrAddressSchema,
    function_name: z.string(),
    code: z.string(),
  })
  .passthrough();

export const instructionSchema = z
  .object({
    address: angrAddressSchema,
    mnemonic: z.string(),
    op_str: z.string(),
    bytes: z.string(),
  })
  .passthrough();

export const basicBlockSchema = z
  .object({
    address: angrAddressSchema,
    size: z.number().int().min(0),
    instruction_count: z.number().int().min(0),
    instructions: z.array(instructionSchema).optional(),
    disasm_error: z.string().optional(),
  })
  .passthrough();
export type AngrBasicBlock = z.infer<typeof basicBlockSchema>;

export const basicBlocksSchema = z
  .object({
    function_address: angrAddressSchema,
    function_name: z.string(),
    block_count: z.number().int().min(0),
    blocks: z.array(basicBlockSchema),
  })
  .passthrough();

export const xrefsSchema = z
  .object({
    address: angrAddressSchema,
    direction: z.enum(["to", "from"]),
    count: z.number().int().min(0),
    xrefs: z.array(
      z
        .object({
          from_address: angrAddressSchema.nullable(),
          to_address: angrAddressSchema.nullable(),
          type: z.string(),
          block_address: angrAddressSchema.nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const stringsSchema = z
  .object({
    count: z.number().int().min(0),
    strings: z.array(
      z
        .object({
          address: angrAddressSchema,
          content: z.string(),
          size: z.number().int().min(0).nullable(),
          type: z.enum(["ascii", "unicode"]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const callGraphSchema = z
  .object({
    node_count: z.number().int().min(0),
    edge_count: z.number().int().min(0),
    nodes: z.array(
      z
        .object({
          address: angrAddressSchema,
          name: z.string(),
          is_plt: z.boolean(),
        })
        .passthrough(),
    ),
    edges: z.array(
      z
        .object({ from: angrAddressSchema, to: angrAddressSchema })
        .passthrough(),
    ),
  })
  .passthrough();
export type AngrCallGraph = z.infer<typeof callGraphSchema>;

const editText = z
  .union([z.string(), z.number(), z.boolean()])
  .nullable()
  .optional()
  .transform((value) => (value == null ? null : String(value)));

export const editEntrySchema = z
  .object({
    index: z.number().int().min(0),
    kind: z.string(),
    status: z.enum(["ok", "unchanged", "error", "skipped"]),
    function_address: angrAddressSchema.nullable(),
    function_name: z.string().nullable(),
    target: editText,
    old: editText,
    new: editText,
    detail: z.record(z.string(), z.unknown()).nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();
export type AngrEditEntry = z.infer<typeof editEntrySchema>;

export const editBatchSchema = z
  .object({
    dry_run: z.boolean(),
    total: z.number().int().min(0),
    succeeded: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    results: z.array(editEntrySchema),
    functions_affected: z.array(angrAddressSchema),
  })
  .passthrough();
export type AngrEditBatch = z.infer<typeof editBatchSchema>;

export const flavorSchema = z
  .object({
    flavor: z.string().min(1),
    previous_flavor: z.string().min(1).optional(),
    available_flavors: z.array(z.string().min(1)).optional(),
    detected_language: z.string().min(1).nullable().optional(),
    detection_confidence: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export const closeProjectSchema = z
  .object({ project_id: z.string(), closed: z.boolean() })
  .passthrough();
