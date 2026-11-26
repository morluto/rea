import { z } from "zod";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimitFor,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";

export const FIRMWARE_LITERAL_POOL_ISAS = [
  "arm-thumb",
  "arm-a32",
  "xtensa",
] as const;

export const firmwareLiteralPoolIsaSchema = z.enum(FIRMWARE_LITERAL_POOL_ISAS);
export type FirmwareLiteralPoolIsa = z.infer<
  typeof firmwareLiteralPoolIsaSchema
>;

export const DEFAULT_LITERAL_POOL_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_LITERAL_POOL_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_LITERAL_POOL_MAX_SCAN_BYTES = 1024 * 1024;
export const MAX_LITERAL_POOL_SCAN_BYTES = 16 * 1024 * 1024;
export const DEFAULT_LITERAL_POOL_MAX_REFERENCES = 16_384;
export const MAX_LITERAL_POOL_REFERENCES = 131_072;
export const DEFAULT_LITERAL_POOL_MAX_SVD_XML_NODES = 200_000;
export const MAX_LITERAL_POOL_SVD_XML_NODES = 1_000_000;
export const MAX_LITERAL_POOL_SVD_XML_CHARS = 16 * 1024 * 1024;

/** Per-call resource budgets for `inspect_firmware_literal_pools`. */
export const FIRMWARE_LITERAL_POOL_BUDGETS = {
  max_file_bytes: {
    minimum: 4,
    maximum: MAX_LITERAL_POOL_FILE_BYTES,
    default_value: DEFAULT_LITERAL_POOL_MAX_FILE_BYTES,
    unit: "bytes",
  },
  max_scan_bytes: {
    minimum: 4,
    maximum: MAX_LITERAL_POOL_SCAN_BYTES,
    default_value: DEFAULT_LITERAL_POOL_MAX_SCAN_BYTES,
    unit: "bytes",
  },
  max_references: {
    minimum: 1,
    maximum: MAX_LITERAL_POOL_REFERENCES,
    default_value: DEFAULT_LITERAL_POOL_MAX_REFERENCES,
    unit: "count",
  },
  max_svd_nodes: {
    minimum: 16,
    maximum: MAX_LITERAL_POOL_SVD_XML_NODES,
    default_value: DEFAULT_LITERAL_POOL_MAX_SVD_XML_NODES,
    unit: "count",
  },
} as const satisfies Record<string, ParameterBudget>;

export type FirmwareLiteralPoolBudget =
  keyof typeof FIRMWARE_LITERAL_POOL_BUDGETS;

export const firmwareLiteralPoolBudgetLimit: (
  parameter: FirmwareLiteralPoolBudget,
  effectiveValue: number,
) => AnalysisParameterLimit = parameterBudgetLimitFor(
  FIRMWARE_LITERAL_POOL_BUDGETS,
);

export const inspectFirmwareLiteralPoolsInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Local firmware binary or flash slice path to disassemble PC-relative literal-pool loads from without executing it.",
  ),
  isa: firmwareLiteralPoolIsaSchema.describe(
    "Instruction set encoding for PC-relative literal-pool disassembly: arm-thumb (16-bit Thumb + 32-bit Thumb-2 LDR literal), arm-a32 (32-bit ARM LDR literal), or xtensa (24-bit L32R with 16-bit narrow instruction framing).",
  ),
  base_address: z
    .string()
    .regex(
      /^0x[0-9a-fA-F]{1,8}$/u,
      "base_address must be a 32-bit hex address such as 0x08000000 or 0x400d0000",
    )
    .describe(
      "Explicit 32-bit load base address corresponding to file offset 0 (for example 0x08000000 for STM32 Flash or 0x400d0000 for ESP32 IROM).",
    ),
  scan_offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_LITERAL_POOL_FILE_BYTES)
    .default(0)
    .describe(
      "Byte offset inside the file where linear instruction scanning begins (2-byte aligned for arm-thumb, 4-byte aligned for arm-a32). Defaults to 0.",
    ),
  max_scan_bytes: parameterBudgetSchema(
    FIRMWARE_LITERAL_POOL_BUDGETS.max_scan_bytes,
  ).describe(
    "Maximum instruction byte span to scan starting from scan_offset. Defaults to 1048576 (1 MiB).",
  ),
  max_references: parameterBudgetSchema(
    FIRMWARE_LITERAL_POOL_BUDGETS.max_references,
  ).describe(
    "Maximum resolved literal-pool load instructions accepted for the scanned window before refusing; complete Evidence retains all resolved references, and detail summary pages mmio_summary and references via inspect_analysis_view.",
  ),
  svd_xml: z
    .string()
    .min(1)
    .max(MAX_LITERAL_POOL_SVD_XML_CHARS)
    .optional()
    .describe(
      "Optional CMSIS-SVD XML document used to bind loaded 32-bit peripheral constants to named <peripheral> address blocks and register offsets.",
    ),
  max_svd_nodes: parameterBudgetSchema(
    FIRMWARE_LITERAL_POOL_BUDGETS.max_svd_nodes,
  ).describe(
    "Maximum XML element/text nodes accepted when parsing svd_xml. Defaults to 200000.",
  ),
  max_file_bytes: parameterBudgetSchema(
    FIRMWARE_LITERAL_POOL_BUDGETS.max_file_bytes,
  ).describe(
    "Maximum firmware file size in bytes accepted for reading. Defaults to 33554432 (32 MiB).",
  ),
});
export type InspectFirmwareLiteralPoolsInput = z.infer<
  typeof inspectFirmwareLiteralPoolsInputSchema
>;

export const literalPoolRegionKindSchema = z.enum([
  "cortex_m_ppb_scs",
  "cortex_m_peripheral",
  "cortex_m_sram",
  "esp_peripheral",
  "esp_sram_rtc",
  "svd_peripheral",
  "mapped_image",
  "other",
]);
export type LiteralPoolRegionKind = z.infer<typeof literalPoolRegionKindSchema>;

export const literalPoolAttributionBasisSchema = z.enum([
  "explicit_profile",
  "architecture_manual",
  "address_map_convention",
  "observed_bounds",
  "unclassified",
]);
export type LiteralPoolAttributionBasis = z.infer<
  typeof literalPoolAttributionBasisSchema
>;

export const literalPoolReferenceSchema = z.strictObject({
  instruction_offset: z.number().int().min(0),
  instruction_address: z.string().regex(/^0x[0-9a-f]+$/u),
  mnemonic: z.enum(["ldr", "ldr.w", "l32r"]),
  target_register: z.string().min(1),
  disassembly: z.string().min(1),
  pool_offset: z.number().int().min(0),
  pool_address: z.string().regex(/^0x[0-9a-f]+$/u),
  loaded_value: z.string().regex(/^0x[0-9a-f]{8}$/u),
  region_kind: literalPoolRegionKindSchema,
  basis: literalPoolAttributionBasisSchema,
  architectural_block: z.string().nullable(),
  svd_peripheral: z.string().nullable(),
  svd_register_offset: z.string().nullable(),
});
export type LiteralPoolReference = z.infer<typeof literalPoolReferenceSchema>;

export const literalPoolMmioSummarySchema = z.strictObject({
  group_key: z.string().min(1),
  region_kind: literalPoolRegionKindSchema,
  basis: literalPoolAttributionBasisSchema,
  base_address: z.string().regex(/^0x[0-9a-f]{8}$/u),
  svd_peripheral: z.string().nullable(),
  architectural_block: z.string().nullable(),
  reference_count: z.number().int().min(1),
  distinct_constants: z.array(z.string().regex(/^0x[0-9a-f]{8}$/u)),
  sample_instruction_addresses: z.array(z.string().regex(/^0x[0-9a-f]+$/u)),
});
export type LiteralPoolMmioSummary = z.infer<
  typeof literalPoolMmioSummarySchema
>;

export const firmwareLiteralPoolsReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().min(0),
  }),
  isa: firmwareLiteralPoolIsaSchema,
  base_address: z.string().regex(/^0x[0-9a-f]+$/u),
  scan_range: z.strictObject({
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    scanned_bytes: z.number().int().min(0),
  }),
  coverage: z.strictObject({
    status: knownCoverageStatusSchema,
    available_from_offset_bytes: z.number().int().min(0),
    retained_references: z.number().int().min(0),
    omitted_references: z.number().int().min(0),
  }),
  counts: z.strictObject({
    resolved_pool_loads: z.number().int().min(0),
    distinct_pool_slots: z.number().int().min(0),
    mmio_pool_loads: z.number().int().min(0),
    out_of_image_pool_targets: z.number().int().min(0),
    suppressed_pool_slot_overlaps: z.number().int().min(0),
  }),
  svd_profile: z.strictObject({
    supplied: z.boolean(),
    peripheral_count: z.number().int().min(0),
    matched_load_count: z.number().int().min(0),
  }),
  mmio_summary: z.array(literalPoolMmioSummarySchema),
  references: z.array(literalPoolReferenceSchema),
  limitations: z.array(z.string()),
});
export type FirmwareLiteralPoolsReport = z.infer<
  typeof firmwareLiteralPoolsReportSchema
>;
