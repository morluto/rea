import { z } from "zod";

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

/** Complete bounded inspection of a caller-selected PE image, without execution. */
export const inspectPeResourcesInputSchema = z.strictObject({
  path: z.string().min(1).describe("Absolute filesystem path to a PE image"),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(536870912)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(65536)
    .default(4096)
    .describe(
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
  directory: z
    .strictObject({
      rva: uint,
      location: range,
      data_directory_location: range,
    })
    .nullable(),
  directories: z.array(
    z.strictObject({
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
  limitations: z.array(z.string()),
});

export type PeResources = z.infer<typeof peResourcesSchema>;
export type InspectPeResourcesInput = z.infer<
  typeof inspectPeResourcesInputSchema
>;
export type PeResourceIdentity = PeResources["resources"][number]["type"];
