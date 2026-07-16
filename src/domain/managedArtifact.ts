import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const tokenSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const offsetSchema = z.number().int().min(0);

const managedPage = <Item extends z.ZodType>(item: Item) =>
  z.object({
    items: z.array(item),
    offset: offsetSchema,
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
    returned: z.number().int().min(0),
    dropped: z.number().int().min(0),
    complete: z.boolean(),
  });

const publicKeyIdentitySchema = z.object({
  kind: z.enum(["none", "public-key", "public-key-token"]),
  byte_length: z.number().int().min(0),
  sha256: digestSchema.nullable(),
  token: z
    .string()
    .regex(/^[a-f0-9]{16}$/u)
    .nullable(),
});

const assemblyIdentitySchema = z.object({
  name: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/u),
  culture: z.string().nullable(),
  flags: z.number().int().min(0).max(0xffff_ffff),
  hash_algorithm: z.number().int().min(0).max(0xffff_ffff),
  public_key: publicKeyIdentitySchema,
  token: tokenSchema,
  row_offset: offsetSchema,
});

const moduleIdentitySchema = z.object({
  name: z.string(),
  generation: z.number().int().min(0).max(0xffff),
  mvid: z.string().uuid().nullable(),
  enc_id: z.string().uuid().nullable(),
  enc_base_id: z.string().uuid().nullable(),
  token: tokenSchema,
  row_offset: offsetSchema,
});

const assemblyReferenceSchema = z.object({
  name: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/u),
  culture: z.string().nullable(),
  flags: z.number().int().min(0).max(0xffff_ffff),
  public_key_or_token: publicKeyIdentitySchema,
  hash_value_sha256: digestSchema.nullable(),
  hash_value_length: z.number().int().min(0),
  token: tokenSchema,
  row_offset: offsetSchema,
});

const managedResourceSchema = z.object({
  name: z.string(),
  flags: z.number().int().min(0).max(0xffff_ffff),
  visibility: z.enum(["public", "private", "unknown"]),
  implementation_token: tokenSchema.nullable(),
  embedded: z.boolean(),
  declared_offset: z.number().int().min(0).max(0xffff_ffff),
  data_length: z.number().int().min(0).nullable(),
  data_sha256: digestSchema.nullable(),
  token: tokenSchema,
  row_offset: offsetSchema,
});

const customAttributeSchema = z.object({
  parent_token: tokenSchema,
  constructor_token: tokenSchema.nullable(),
  type_name: z.string().nullable(),
  value_length: z.number().int().min(0),
  value_sha256: digestSchema,
  decoded_fixed_string: z.string().nullable(),
  token: tokenSchema,
  row_offset: offsetSchema,
});

const managedParseIssueSchema = z.object({
  code: z.enum([
    "invalid-cli-header",
    "invalid-directory",
    "invalid-metadata-root",
    "invalid-stream",
    "missing-stream",
    "invalid-tables",
    "invalid-row",
    "invalid-heap-index",
    "invalid-string",
    "invalid-blob",
    "invalid-guid",
    "invalid-resource",
    "limit-exceeded",
  ]),
  scope: z.string().min(1),
  offset: offsetSchema.nullable(),
  detail: z.string().min(1),
});

/** Provider-neutral, execution-free PE/CLI triage and identity result. */
export const managedArtifactInspectionSchema = z.object({
  schema_version: z.literal(1),
  artifact: z.object({
    path: z.string().min(1),
    sha256: digestSchema,
    byte_length: z.number().int().min(0),
    format: z.literal("pe"),
  }),
  pe: z.object({
    machine: z.number().int().min(0).max(0xffff),
    machine_hex: z.string().regex(/^0x[0-9a-f]{4}$/u),
    architecture: z.enum(["x86", "x86_64", "arm", "arm64"]),
    optional_header: z.enum(["pe32", "pe32-plus"]),
    section_count: z.number().int().min(1).max(96),
    characteristics: z.number().int().min(0).max(0xffff),
    cli: z
      .object({
        header_offset: offsetSchema,
        header_size: z.number().int().min(72),
        runtime_version: z.string(),
        flags: z.number().int().min(0).max(0xffff_ffff),
        flag_names: z.array(z.string()),
        entry_point: z.object({
          kind: z.enum(["metadata-token", "native-rva", "none"]),
          value: z.string().nullable(),
        }),
        metadata_rva: z.number().int().min(1).max(0xffff_ffff),
        metadata_size: z.number().int().min(1).max(0xffff_ffff),
        resources_rva: z.number().int().min(0).max(0xffff_ffff),
        resources_size: z.number().int().min(0).max(0xffff_ffff),
        strong_name_rva: z.number().int().min(0).max(0xffff_ffff),
        strong_name_size: z.number().int().min(0).max(0xffff_ffff),
        managed_native_header_rva: z.number().int().min(0).max(0xffff_ffff),
        managed_native_header_size: z.number().int().min(0).max(0xffff_ffff),
        ready_to_run_signature: z.boolean(),
      })
      .nullable(),
  }),
  classification: z.object({
    status: z.enum(["managed", "not-managed", "malformed"]),
    container: z.literal("pe"),
    runtime_family: z.enum([
      "dotnet-framework",
      "modern-dotnet",
      "unity-mono",
      "mixed-clr-native",
      "unknown",
    ]),
    implementation: z.enum([
      "cil",
      "cil-and-ready-to-run",
      "cpp-cli-mixed",
      "metadata-only",
      "not-managed",
      "unknown",
    ]),
    managed_architecture: z.enum([
      "anycpu",
      "anycpu-prefer-32",
      "x86",
      "x86_64",
      "arm",
      "arm64",
      "unknown",
    ]),
    evidence: z.array(
      z.object({
        code: z.string().min(1),
        detail: z.string().min(1),
        file_offset: offsetSchema.nullable(),
      }),
    ),
  }),
  metadata: z.object({
    status: z.enum(["absent", "complete", "partial", "malformed"]),
    version: z.string().nullable(),
    stream_names: z.array(z.string()),
    table_row_counts: z.record(
      z.string(),
      z.number().int().min(0).max(0xffff_ffff),
    ),
  }),
  module: moduleIdentitySchema.nullable(),
  assembly: assemblyIdentitySchema.nullable(),
  target_frameworks: z.array(z.string()),
  references: managedPage(assemblyReferenceSchema),
  resources: managedPage(managedResourceSchema),
  attributes: managedPage(customAttributeSchema),
  coverage: z.object({
    state: z.enum(["complete", "partial", "unavailable"]),
    issues: z.array(managedParseIssueSchema),
  }),
  limitations: z.array(z.string()),
});

export type ManagedArtifactInspection = z.infer<
  typeof managedArtifactInspectionSchema
>;
export type ManagedParseIssue = z.infer<typeof managedParseIssueSchema>;
