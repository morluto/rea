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

const managedSignatureSchema = z.object({
  raw_length: z.number().int().min(0),
  raw_sha256: digestSchema,
  kind: z.enum(["method", "field", "unknown"]),
  parse_status: z.enum(["decoded", "partial", "unsupported", "malformed"]),
  calling_convention: z.string().nullable(),
  generic_parameter_count: z.number().int().min(0).nullable(),
  parameter_count: z.number().int().min(0).nullable(),
  return_type: z.string().nullable(),
  parameter_types: z.array(z.string()),
  field_type: z.string().nullable(),
  issue: z.string().nullable(),
});

const managedTypeSchema = z.object({
  token: tokenSchema,
  row_offset: offsetSchema,
  namespace: z.string(),
  name: z.string(),
  full_name: z.string(),
  flags: z.number().int().min(0).max(0xffff_ffff),
  extends_token: tokenSchema.nullable(),
  field_list: z.object({
    first_row: z.number().int().min(1).nullable(),
    last_row: z.number().int().min(0).nullable(),
    count: z.number().int().min(0),
  }),
  method_list: z.object({
    first_row: z.number().int().min(1).nullable(),
    last_row: z.number().int().min(0).nullable(),
    count: z.number().int().min(0),
  }),
});

const managedFieldSchema = z.object({
  token: tokenSchema,
  row_offset: offsetSchema,
  declaring_type_token: tokenSchema.nullable(),
  declaring_type: z.string().nullable(),
  name: z.string(),
  flags: z.number().int().min(0).max(0xffff),
  signature: managedSignatureSchema,
});

const managedExceptionRegionSchema = z.object({
  flags: z.number().int().min(0).max(0xffff_ffff),
  try_offset: z.number().int().min(0),
  try_length: z.number().int().min(0),
  handler_offset: z.number().int().min(0),
  handler_length: z.number().int().min(0),
  class_token: tokenSchema.nullable(),
  filter_offset: z.number().int().min(0).nullable(),
});

const managedInstructionAnchorSchema = z.object({
  il_offset: z.number().int().min(0),
  opcode: z.string().min(1),
  operand_kind: z.enum([
    "none",
    "branch",
    "constant",
    "field",
    "method",
    "signature",
    "string",
    "switch",
    "token",
    "type",
    "variable",
    "unknown",
  ]),
  operand: z.string().nullable(),
});

const managedMethodBodySchema = z.object({
  status: z.enum(["present", "absent", "malformed", "too-large"]),
  header_format: z.enum(["tiny", "fat", "none", "unknown"]),
  rva: z.number().int().min(0).max(0xffff_ffff),
  file_offset: offsetSchema.nullable(),
  max_stack: z.number().int().min(0).nullable(),
  init_locals: z.boolean().nullable(),
  local_var_sig_token: tokenSchema.nullable(),
  il_size: z.number().int().min(0),
  il_sha256: digestSchema.nullable(),
  normalized_il_sha256: digestSchema.nullable(),
  instruction_count: z.number().int().min(0),
  decoded_instruction_count: z.number().int().min(0),
  truncated_instructions: z.number().int().min(0),
  opcode_counts: z.record(z.string(), z.number().int().min(1)),
  anchors: z.array(managedInstructionAnchorSchema),
  exception_regions: z.array(managedExceptionRegionSchema),
  issue: z.string().nullable(),
});

const managedMethodSchema = z.object({
  token: tokenSchema,
  row_offset: offsetSchema,
  declaring_type_token: tokenSchema.nullable(),
  declaring_type: z.string().nullable(),
  name: z.string(),
  rva: z.number().int().min(0).max(0xffff_ffff),
  impl_flags: z.number().int().min(0).max(0xffff),
  flags: z.number().int().min(0).max(0xffff),
  signature: managedSignatureSchema,
  body: managedMethodBodySchema,
});

const managedMemberReferenceSchema = z.object({
  token: tokenSchema,
  row_offset: offsetSchema,
  parent_token: tokenSchema.nullable(),
  name: z.string(),
  signature: managedSignatureSchema,
});

const managedModuleReferenceSchema = z.object({
  token: tokenSchema,
  row_offset: offsetSchema,
  name: z.string(),
});

const managedNativeImportSchema = z.object({
  token: tokenSchema,
  row_offset: offsetSchema,
  mapping_flags: z.number().int().min(0).max(0xffff),
  mapping_flags_hex: z.string().regex(/^0x[0-9a-f]{4}$/u),
  member_token: tokenSchema.nullable(),
  member_kind: z.enum(["method", "field", "unknown"]),
  member_name: z.string().nullable(),
  import_name: z.string(),
  import_scope_token: tokenSchema.nullable(),
  import_scope_name: z.string().nullable(),
  no_mangle: z.boolean(),
  char_set: z.enum(["not-specified", "ansi", "unicode", "auto", "unknown"]),
  call_convention: z.enum([
    "not-specified",
    "winapi",
    "cdecl",
    "stdcall",
    "thiscall",
    "fastcall",
    "unknown",
  ]),
  supports_last_error: z.boolean(),
  best_fit: z.enum(["assembly-default", "enabled", "disabled", "unknown"]),
  throw_on_unmappable_char: z.enum([
    "assembly-default",
    "enabled",
    "disabled",
    "unknown",
  ]),
  verification: z.literal("managed-declaration-only"),
});

const managedNativeImplementationSchema = z.object({
  token: tokenSchema,
  row_offset: offsetSchema,
  name: z.string(),
  rva: z.number().int().min(0).max(0xffff_ffff),
  flags: z.number().int().min(0).max(0xffff),
  impl_flags: z.number().int().min(0).max(0xffff),
  code_type: z.enum(["il", "native", "optil", "runtime", "unknown"]),
  managed_kind: z.enum(["managed", "unmanaged", "unknown"]),
  pinvoke_declared: z.boolean(),
  boundary_kind: z.enum([
    "pinvoke",
    "native-body",
    "runtime-provided",
    "unmanaged-method",
    "mixed-or-unknown",
  ]),
  body_interpretation: z.enum([
    "managed-cil",
    "native-or-runtime",
    "not-file-backed",
    "unknown",
  ]),
});

const managedCallEdgeSchema = z.object({
  caller_token: tokenSchema,
  caller: z.string().nullable(),
  opcode: z.string(),
  target_token: tokenSchema,
  target_kind: z.enum(["method-def", "member-ref", "method-spec", "unknown"]),
  target_name: z.string().nullable(),
});

const managedFieldAccessSchema = z.object({
  method_token: tokenSchema,
  method: z.string().nullable(),
  opcode: z.string(),
  field_token: tokenSchema,
  field_name: z.string().nullable(),
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

/** Provider-neutral, execution-free metadata/signature/IL member inspection. */
export const managedMemberInspectionSchema = z.object({
  schema_version: z.literal(1),
  artifact: z.object({
    path: z.string().min(1),
    sha256: digestSchema,
    byte_length: z.number().int().min(0),
    format: z.literal("pe"),
  }),
  module: moduleIdentitySchema.nullable(),
  metadata: z.object({
    status: z.enum(["absent", "complete", "partial", "malformed"]),
    version: z.string().nullable(),
    table_row_counts: z.record(
      z.string(),
      z.number().int().min(0).max(0xffff_ffff),
    ),
  }),
  identity_scope: z.object({
    token_identity: z.literal("build-local"),
    requires_artifact_sha256: digestSchema,
    requires_mvid: z.string().uuid().nullable(),
  }),
  types: managedPage(managedTypeSchema),
  fields: managedPage(managedFieldSchema),
  methods: managedPage(managedMethodSchema),
  member_refs: managedPage(managedMemberReferenceSchema),
  call_edges: managedPage(managedCallEdgeSchema),
  field_accesses: managedPage(managedFieldAccessSchema),
  coverage: z.object({
    state: z.enum(["complete", "partial", "unavailable"]),
    issues: z.array(managedParseIssueSchema),
  }),
  limitations: z.array(z.string()),
});

/** Provider-neutral managed/native boundary observations from PE/CLI metadata. */
export const managedNativeBoundaryInspectionSchema = z.object({
  schema_version: z.literal(1),
  artifact: z.object({
    path: z.string().min(1),
    sha256: digestSchema,
    byte_length: z.number().int().min(0),
    format: z.literal("pe"),
  }),
  module: moduleIdentitySchema.nullable(),
  metadata: z.object({
    status: z.enum(["absent", "complete", "partial", "malformed"]),
    version: z.string().nullable(),
    table_row_counts: z.record(
      z.string(),
      z.number().int().min(0).max(0xffff_ffff),
    ),
  }),
  identity_scope: z.object({
    token_identity: z.literal("build-local"),
    requires_artifact_sha256: digestSchema,
    requires_mvid: z.string().uuid().nullable(),
  }),
  cli_native: z.object({
    il_only: z.boolean(),
    requires_32bit: z.boolean(),
    strong_name_signed: z.boolean(),
    native_entry_point: z.boolean(),
    ready_to_run_signature: z.boolean(),
    managed_native_header_rva: z.number().int().min(0).max(0xffff_ffff),
    managed_native_header_size: z.number().int().min(0).max(0xffff_ffff),
  }),
  module_refs: managedPage(managedModuleReferenceSchema),
  pinvoke_imports: managedPage(managedNativeImportSchema),
  native_implementations: managedPage(managedNativeImplementationSchema),
  summary: z.object({
    module_ref_count: z.number().int().min(0),
    pinvoke_import_count: z.number().int().min(0),
    native_implementation_count: z.number().int().min(0),
    ready_to_run: z.boolean(),
    mixed_mode_or_native_header: z.boolean(),
  }),
  coverage: z.object({
    state: z.enum(["complete", "partial", "unavailable"]),
    issues: z.array(managedParseIssueSchema),
  }),
  limitations: z.array(z.string()),
});

export type ManagedArtifactInspection = z.infer<
  typeof managedArtifactInspectionSchema
>;
export type ManagedMemberInspection = z.infer<
  typeof managedMemberInspectionSchema
>;
export type ManagedNativeBoundaryInspection = z.infer<
  typeof managedNativeBoundaryInspectionSchema
>;
export type ManagedParseIssue = z.infer<typeof managedParseIssueSchema>;
