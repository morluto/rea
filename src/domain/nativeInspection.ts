import { z } from "zod";
import { jsonValueSchema } from "./jsonValue.js";

const hexAddress = z.string().regex(/^0x[a-fA-F0-9]+$/u);
const coverage = <Schema extends z.ZodType>(item: Schema) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0).nullable(),
    exhaustive: z.boolean(),
    limitations: z.array(z.string()),
  });

const nativeCommandInvocationSchema = z.object({
  tool: z.string().min(1),
  command: z.array(z.string()),
  tool_version: z.string().nullable(),
  version_reason: z.string().nullable(),
  executable_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  exit: z.object({
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
  stdout_bytes: z.number().int().min(0),
  stderr_bytes: z.number().int().min(0),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
});

const architectureSchema = z.object({
  name: z.string(),
  cpu_type: z.string().nullable(),
  cpu_subtype: z.string().nullable(),
  file_offset: z.number().int().min(0).nullable(),
  size: z.number().int().min(0).nullable(),
  alignment: z.number().int().min(0).nullable(),
});
const permissionSchema = z.object({
  read: z.boolean().nullable(),
  write: z.boolean().nullable(),
  execute: z.boolean().nullable(),
  raw: z.string().nullable(),
});
const sectionSchema = z.object({
  segment: z.string(),
  name: z.string(),
  address: hexAddress.nullable(),
  size: z.number().int().min(0).nullable(),
  file_offset: z.number().int().min(0).nullable(),
  alignment: z.number().int().min(0).nullable(),
  flags: z.array(z.string()),
});
const segmentSchema = z.object({
  name: z.string(),
  vm_address: hexAddress.nullable(),
  vm_size: z.number().int().min(0).nullable(),
  file_offset: z.number().int().min(0).nullable(),
  file_size: z.number().int().min(0).nullable(),
  maximum_permissions: permissionSchema,
  initial_permissions: permissionSchema,
  sections: coverage(sectionSchema),
});
const symbolSchema = z.object({
  name: z.string(),
  address: hexAddress.nullable(),
  weak: z.boolean().nullable(),
  reexport: z.boolean().nullable(),
  source: z.string().nullable(),
});
const dependencySchema = z.object({
  path: z.string(),
  kind: z.string(),
  current_version: z.string().nullable(),
  compatibility_version: z.string().nullable(),
});
const loadCommandSchema = z.object({
  index: z.number().int().min(0),
  kind: z.string(),
  file_offset: z.number().int().min(0).nullable(),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
});
const buildMetadataSchema = z.object({
  platform: z.string().nullable(),
  minimum_os: z.string().nullable(),
  sdk: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), version: z.string() })),
});

export const inspectMachoSchema = z.object({
  format: z.literal("mach-o"),
  endian: z.enum(["little", "big"]).nullable(),
  word_size: z.union([z.literal(32), z.literal(64)]).nullable(),
  file_type: z.string().nullable(),
  flags: z.array(z.string()),
  uuid: z.string().nullable(),
  entrypoints: coverage(z.object({ file_offset: z.number().int().min(0) })),
  architectures: coverage(architectureSchema),
  build_metadata: coverage(buildMetadataSchema),
  load_commands: coverage(loadCommandSchema),
  dependencies: coverage(dependencySchema),
  imports: coverage(symbolSchema),
  exports: coverage(symbolSchema),
  segments: coverage(segmentSchema),
  provenance: z.array(nativeCommandInvocationSchema),
  limitations: z.array(z.string()),
});

export const inspectSignatureSchema = z.object({
  signed: z.boolean(),
  identifier: z.string().nullable(),
  team_identifier: z.string().nullable(),
  format: z.string().nullable(),
  cdhashes: z.array(z.string()),
  hash_algorithms: z.array(z.string()),
  authorities: z.array(z.string()),
  designated_requirement: z.string().nullable(),
  entitlements: jsonValueSchema.nullable(),
  timestamp: z.string().nullable(),
  hardened_runtime: z.boolean().nullable(),
  provenance: z.array(nativeCommandInvocationSchema),
  limitations: z.array(z.string()),
});

export const inspectPlistSchema = z.object({
  format: z.enum(["xml", "binary", "json", "unknown"]),
  value: jsonValueSchema,
  bundle: z.object({
    identifier: z.string().nullable(),
    executable: z.string().nullable(),
    name: z.string().nullable(),
    version: z.string().nullable(),
    short_version: z.string().nullable(),
  }),
  source_path: z.string(),
  provenance: z.array(nativeCommandInvocationSchema),
  limitations: z.array(z.string()),
});

export const listArchitecturesSchema = z.object({
  architectures: coverage(architectureSchema),
  provenance: z.array(nativeCommandInvocationSchema),
  limitations: z.array(z.string()),
});

export const demangleSwiftSchema = z.object({
  symbols: z.array(
    z.object({
      input: z.string(),
      output: z.string(),
      status: z.enum(["demangled", "unchanged", "invalid"]),
    }),
  ),
  provenance: z.array(nativeCommandInvocationSchema),
  limitations: z.array(z.string()),
});

export type NativeCommandInvocation = z.infer<
  typeof nativeCommandInvocationSchema
>;
export type InspectSignature = z.infer<typeof inspectSignatureSchema>;
