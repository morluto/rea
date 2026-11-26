import { z } from "zod";
import { peHeaderAnomaliesSchema } from "./peHeaderAnomalies.js";
import { peImageBaseSchema } from "./peAddressSpace.js";

import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimit,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";

const uint = z.number().int().min(0).max(0xffffffff);
const range = z.strictObject({ offset: uint, bytes: uint });
const identity = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("id"), id: uint }),
  z.strictObject({
    kind: z.literal("name"),
    name: z.string(),
    utf16le_hex: z.string().regex(/^(?:[0-9a-f]{4})*$/),
    location: range,
  }),
]);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_PE_FILE_BYTES = 536870912;
/** Hard ceiling on the caller-selected resource-directory-entry budget. */
export const MAX_INSPECT_PE_DIRECTORY_ENTRIES = 65536;
/** `max_entries` of `inspect_pe_resources`. */
export const PE_RESOURCE_ENTRY_BUDGET = {
  minimum: 1,
  maximum: MAX_INSPECT_PE_DIRECTORY_ENTRIES,
  default_value: 16384,
  unit: "count",
} as const satisfies ParameterBudget;
/** `max_metadata_bytes`: the complete resource result retained before a refusal. */
export const PE_RESOURCE_METADATA_BUDGET = {
  minimum: 1024,
  maximum: 256 * 1024 * 1024,
  default_value: 8 * 1024 * 1024,
  unit: "bytes",
} as const satisfies ParameterBudget;
/** The `max_metadata_bytes` control that refused a resource result. */
export const peResourceMetadataLimit = (effectiveValue: number) =>
  parameterBudgetLimit(
    "max_metadata_bytes",
    PE_RESOURCE_METADATA_BUDGET,
    effectiveValue,
  );
/** The `max_entries` control that refused a resource directory. */
export const peResourceEntryLimit = (effectiveValue: number) =>
  parameterBudgetLimit("max_entries", PE_RESOURCE_ENTRY_BUDGET, effectiveValue);

/** Complete bounded inspection of a caller-selected PE image, without execution. */
export const inspectPeResourcesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a PE image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_PE_FILE_BYTES)
    .default(67108864)
    .describe(
      "Maximum bytes this reader reads from the artifact: headers, directories and the ranges they reference (default 64 MiB). The file may be larger; its one hashing pass is not counted",
    ),
  // Windows resource images carry thousands of entries: Windows 11 25H2
  // SystemResources measures imageres.dll.mun at 6476 examined entries,
  // shell32.dll.mun at 5903 and wmploc.DLL.mun at 5440. The default admits
  // those stock images with headroom; the independent 8 MiB metadata budget
  // still bounds allocation.
  max_metadata_bytes: parameterBudgetSchema(
    PE_RESOURCE_METADATA_BUDGET,
  ).describe(
    "Maximum bytes of the complete resource result retained before refusal (default 8 MiB)",
  ),
  max_entries: parameterBudgetSchema(PE_RESOURCE_ENTRY_BUDGET).describe(
    "Maximum resource directory entries to examine; exceeding the budget fails without partial success",
  ),
});

/** Original file/RVA locations and resource identities; icon edges are static relationships. */
export const peResourcesSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: uint,
  }),
  format: z.enum(["pe32", "pe32-plus"]),
  machine: uint,
  image_base: peImageBaseSchema,
  directory: z
    .strictObject({
      rva: uint,
      location: range,
      data_directory_location: range,
    })
    .nullable(),
  directories: z.array(
    z.strictObject({
      path: z
        .array(identity)
        .max(2)
        .describe(
          "Type/name identities leading to this directory; [] for the root",
        ),
      entry_locations: z
        .array(range)
        .max(2)
        .describe("Incoming entry file ranges corresponding to path"),
      location: range,
      characteristics: uint,
      timestamp: uint,
      major_version: uint,
      minor_version: uint,
      named_entries: uint,
      id_entries: uint,
    }),
  ),
  resources: z.array(
    z.strictObject({
      index: uint,
      type: identity,
      name: identity,
      language: identity,
      entry_locations: z.array(range).length(3),
      data_entry_location: range,
      code_page: uint,
      reserved: uint,
      payload: z.strictObject({
        rva: uint,
        location: range,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    }),
  ),
  icon_groups: z.array(
    z.strictObject({
      resource_index: uint,
      images: z.array(
        z.strictObject({
          location: range,
          width: uint,
          height: uint,
          color_count: uint,
          reserved: uint,
          planes: uint,
          bit_count: uint,
          declared_bytes: uint,
          resource_id: uint,
          candidate_resource_indices: z.array(uint),
          same_language_resource_index: uint.nullable(),
          size_matches: z.boolean().nullable(),
        }),
      ),
    }),
  ),
  coverage: z.strictObject({
    status: z.literal("complete"),
    examined_entries: uint,
    resources: uint,
  }),
  /** Evidence saved before this field existed omits it. */
  header_anomalies: peHeaderAnomaliesSchema.optional(),
  limitations: z.array(z.string()),
});

export type PeResources = z.infer<typeof peResourcesSchema>;
export type InspectPeResourcesInput = z.infer<
  typeof inspectPeResourcesInputSchema
>;
export type PeResourceIdentity = PeResources["resources"][number]["type"];
