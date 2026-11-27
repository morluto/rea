import { z } from "zod";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { NATIVE_STRUCTURE_LIMIT } from "../binaryContainer.js";
import { maxStructureBytesSchema } from "../native/nativeStructureBudget.js";

export const DEFAULT_GPU_OBJECT_BYTES = 128 * 1024 * 1024;
const DEFAULT_GPU_WORK_BYTES = 512 * 1024 * 1024;
export const DEFAULT_GPU_REPORT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_GPU_METADATA_BYTES = 8 * 1024 * 1024;
export const DEFAULT_GPU_PARSER_ENTRIES = 65_536;
export const DEFAULT_GPU_PARSER_VISITS = 262_144;
export const DEFAULT_GPU_TOKEN_BYTES = 65_536;

export const GPU_CONTAINER_NESTING_LIMIT = "gpu-container-nesting-depth";
export const GPU_AMD_METADATA_DEPTH_LIMIT = "amdgpu-metadata-depth";
export const GPU_OBJECT_BYTES_LIMIT = "gpu-object-bytes";
export const GPU_WORK_BYTES_LIMIT = "gpu-work-bytes";
export const GPU_METADATA_BYTES_LIMIT = "gpu-metadata-bytes";
export const GPU_PARSER_ENTRIES_LIMIT = "gpu-parser-entries";
export const GPU_PARSER_VISITS_LIMIT = "gpu-parser-visits";
export const GPU_TOKEN_BYTES_LIMIT = "gpu-token-bytes";
export const GPU_RETAINED_REPORT_BYTES_LIMIT = "gpu-retained-report-bytes";
const GPU_HIP_BUNDLE_ENTRIES_LIMIT = "hip-bundle-entries";
const GPU_HIP_BUNDLE_ID_BYTES_LIMIT = "hip-bundle-id-bytes";
const GPU_HIP_BUNDLE_DIRECTORY_BYTES_LIMIT = "hip-bundle-directory-bytes";
const GPU_AMD_METADATA_VALUES_LIMIT = "amdgpu-metadata-values";

const GPU_CODE_OBJECTS_BUDGETS = {
  max_object_bytes: {
    minimum: 1,
    maximum: DEFAULT_GPU_OBJECT_BYTES,
    default_value: DEFAULT_GPU_OBJECT_BYTES,
    unit: "bytes",
  },
  max_work_bytes: {
    minimum: 1,
    maximum: DEFAULT_GPU_WORK_BYTES,
    default_value: DEFAULT_GPU_WORK_BYTES,
    unit: "bytes",
  },
  max_report_bytes: {
    minimum: 1,
    maximum: DEFAULT_GPU_REPORT_BYTES,
    default_value: DEFAULT_GPU_REPORT_BYTES,
    unit: "bytes",
  },
  max_metadata_bytes: {
    minimum: 1,
    maximum: DEFAULT_GPU_METADATA_BYTES,
    default_value: DEFAULT_GPU_METADATA_BYTES,
    unit: "bytes",
  },
  max_parser_entries: {
    minimum: 1,
    maximum: DEFAULT_GPU_PARSER_ENTRIES,
    default_value: DEFAULT_GPU_PARSER_ENTRIES,
    unit: "count",
  },
  max_parser_visits: {
    minimum: 1,
    maximum: DEFAULT_GPU_PARSER_VISITS,
    default_value: DEFAULT_GPU_PARSER_VISITS,
    unit: "count",
  },
  max_token_bytes: {
    minimum: 1,
    maximum: DEFAULT_GPU_TOKEN_BYTES,
    default_value: DEFAULT_GPU_TOKEN_BYTES,
    unit: "bytes",
  },
} as const;

type GpuCodeObjectsBudgetParameter = keyof typeof GPU_CODE_OBJECTS_BUDGETS;

/** Optional per-call budget fields for `inspect_gpu_code_objects`. */
export const gpuCodeObjectsBudgetFields = {
  max_object_bytes: z
    .number()
    .int()
    .min(GPU_CODE_OBJECTS_BUDGETS.max_object_bytes.minimum)
    .max(GPU_CODE_OBJECTS_BUDGETS.max_object_bytes.maximum)
    .optional()
    .describe(
      `Maximum bytes for one GPU object buffer read or decoded payload, legacy CCOB v1 recovery scan, or cumulative CUDA ELF metadata reads (default ${String(DEFAULT_GPU_OBJECT_BYTES)}, up to ${String(GPU_CODE_OBJECTS_BUDGETS.max_object_bytes.maximum)})`,
    ),
  max_work_bytes: z
    .number()
    .int()
    .min(GPU_CODE_OBJECTS_BUDGETS.max_work_bytes.minimum)
    .max(GPU_CODE_OBJECTS_BUDGETS.max_work_bytes.maximum)
    .optional()
    .describe(
      `Maximum aggregate payload input, decoded output, native-section, and AMDGPU note/structure read bytes per inspection (default ${String(DEFAULT_GPU_WORK_BYTES)}, up to ${String(GPU_CODE_OBJECTS_BUDGETS.max_work_bytes.maximum)})`,
    ),
  max_report_bytes: z
    .number()
    .int()
    .min(GPU_CODE_OBJECTS_BUDGETS.max_report_bytes.minimum)
    .max(GPU_CODE_OBJECTS_BUDGETS.max_report_bytes.maximum)
    .optional()
    .describe(
      `Maximum bytes for retained GPU report facts, standalone or embedded PTX text, Clang offload bundle directories, and CUDA temporary indexes (default ${String(DEFAULT_GPU_REPORT_BYTES)}, up to ${String(GPU_CODE_OBJECTS_BUDGETS.max_report_bytes.maximum)})`,
    ),
  max_metadata_bytes: z
    .number()
    .int()
    .min(GPU_CODE_OBJECTS_BUDGETS.max_metadata_bytes.minimum)
    .max(GPU_CODE_OBJECTS_BUDGETS.max_metadata_bytes.maximum)
    .optional()
    .describe(
      `Maximum AMDGPU ELF note discovery and MessagePack metadata bytes (default ${String(DEFAULT_GPU_METADATA_BYTES)}, up to ${String(GPU_CODE_OBJECTS_BUDGETS.max_metadata_bytes.maximum)})`,
    ),
  max_structure_bytes: maxStructureBytesSchema,
  max_parser_entries: z
    .number()
    .int()
    .min(GPU_CODE_OBJECTS_BUDGETS.max_parser_entries.minimum)
    .max(GPU_CODE_OBJECTS_BUDGETS.max_parser_entries.maximum)
    .optional()
    .describe(
      `Maximum entries per Clang offload bundle directory, PTX kernel/parameter list, or AMDGPU MessagePack container (default ${String(DEFAULT_GPU_PARSER_ENTRIES)}, up to ${String(GPU_CODE_OBJECTS_BUDGETS.max_parser_entries.maximum)})`,
    ),
  max_parser_visits: z
    .number()
    .int()
    .min(GPU_CODE_OBJECTS_BUDGETS.max_parser_visits.minimum)
    .max(GPU_CODE_OBJECTS_BUDGETS.max_parser_visits.maximum)
    .optional()
    .describe(
      `Maximum aggregate CUDA ELF metadata record/symbol visits or AMDGPU MessagePack values per code object (default ${String(DEFAULT_GPU_PARSER_VISITS)}, up to ${String(GPU_CODE_OBJECTS_BUDGETS.max_parser_visits.maximum)})`,
    ),
  max_token_bytes: z
    .number()
    .int()
    .min(GPU_CODE_OBJECTS_BUDGETS.max_token_bytes.minimum)
    .max(GPU_CODE_OBJECTS_BUDGETS.max_token_bytes.maximum)
    .optional()
    .describe(
      `Maximum bytes for one Clang offload bundle ID, PTX token, or AMDGPU MessagePack string/binary scalar (default ${String(DEFAULT_GPU_TOKEN_BYTES)}, up to ${String(GPU_CODE_OBJECTS_BUDGETS.max_token_bytes.maximum)})`,
    ),
} as const;

/** Effective per-inspection GPU budgets after applying defaults to omitted fields. */
export interface GpuCodeObjectsBudgets {
  readonly maxObjectBytes: number;
  readonly maxWorkBytes: number;
  readonly maxReportBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxStructureBytes: number | undefined;
  readonly maxParserEntries: number;
  readonly maxParserVisits: number;
  readonly maxTokenBytes: number;
}

export const resolveGpuCodeObjectsBudgets = (input: {
  readonly max_object_bytes?: number | undefined;
  readonly max_work_bytes?: number | undefined;
  readonly max_report_bytes?: number | undefined;
  readonly max_metadata_bytes?: number | undefined;
  readonly max_structure_bytes?: number | undefined;
  readonly max_parser_entries?: number | undefined;
  readonly max_parser_visits?: number | undefined;
  readonly max_token_bytes?: number | undefined;
}): GpuCodeObjectsBudgets => ({
  maxObjectBytes: input.max_object_bytes ?? DEFAULT_GPU_OBJECT_BYTES,
  maxWorkBytes: input.max_work_bytes ?? DEFAULT_GPU_WORK_BYTES,
  maxReportBytes: input.max_report_bytes ?? DEFAULT_GPU_REPORT_BYTES,
  maxMetadataBytes: input.max_metadata_bytes ?? DEFAULT_GPU_METADATA_BYTES,
  maxStructureBytes: input.max_structure_bytes,
  maxParserEntries: input.max_parser_entries ?? DEFAULT_GPU_PARSER_ENTRIES,
  maxParserVisits: input.max_parser_visits ?? DEFAULT_GPU_PARSER_VISITS,
  maxTokenBytes: input.max_token_bytes ?? DEFAULT_GPU_TOKEN_BYTES,
});

export const formatGpuByteBudget = (bytes: number): string =>
  bytes % (1024 * 1024) === 0
    ? `${String(bytes / (1024 * 1024))} MiB`
    : `${String(bytes)}-byte`;

export const gpuBudgetParameterForLimit = (
  name: string,
): GpuCodeObjectsBudgetParameter | "max_structure_bytes" | undefined => {
  if (name === NATIVE_STRUCTURE_LIMIT) return "max_structure_bytes";
  if (name === GPU_WORK_BYTES_LIMIT) return "max_work_bytes";
  if (name === GPU_OBJECT_BYTES_LIMIT) return "max_object_bytes";
  if (name === GPU_METADATA_BYTES_LIMIT) return "max_metadata_bytes";
  if (
    name === GPU_HIP_BUNDLE_ENTRIES_LIMIT ||
    name === GPU_PARSER_ENTRIES_LIMIT
  )
    return "max_parser_entries";
  if (
    name === GPU_AMD_METADATA_VALUES_LIMIT ||
    name === GPU_PARSER_VISITS_LIMIT
  )
    return "max_parser_visits";
  if (name === GPU_HIP_BUNDLE_ID_BYTES_LIMIT || name === GPU_TOKEN_BYTES_LIMIT)
    return "max_token_bytes";
  if (
    name === GPU_RETAINED_REPORT_BYTES_LIMIT ||
    name === GPU_HIP_BUNDLE_DIRECTORY_BYTES_LIMIT
  )
    return "max_report_bytes";
  return undefined;
};

export const gpuCodeObjectsBudgetLimit = (
  parameter: GpuCodeObjectsBudgetParameter,
  effectiveValue: number,
  requiredValue?: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter,
  effective_value: effectiveValue,
  ...GPU_CODE_OBJECTS_BUDGETS[parameter],
  applies_at: "next_call",
  ...(requiredValue === undefined ? {} : { required_value: requiredValue }),
});
