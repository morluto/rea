import { createEvidence } from "../domain/evidence.js";
import type { ManagedMemberInspection } from "../domain/managedArtifact.js";

const MANAGED_STATIC_EXAMPLE_PROVIDER = {
  id: "rea-dotnet-static",
  name: "REA managed static analysis provider",
  version: "1",
} as const;

const emptyManagedMembers = (
  sha256: string,
  mvid: string,
): ManagedMemberInspection => ({
  schema_version: 1,
  artifact: {
    path: `/examples/${sha256.slice(0, 8)}.dll`,
    sha256,
    byte_length: 4096,
    format: "pe",
  },
  module: {
    name: "Example.dll",
    generation: 0,
    mvid,
    enc_id: null,
    enc_base_id: null,
    token: "0x00000001",
    row_offset: 0,
  },
  metadata: {
    status: "complete",
    version: "v4.0.30319",
    table_row_counts: {},
  },
  identity_scope: {
    token_identity: "build-local",
    requires_artifact_sha256: sha256,
    requires_mvid: mvid,
  },
  types: emptyPage(100),
  fields: emptyPage(100),
  methods: emptyPage(100),
  member_refs: emptyPage(100),
  call_edges: emptyPage(250),
  field_accesses: emptyPage(250),
  coverage: { state: "complete", issues: [] },
  limitations: [],
});

const emptyPage = <Item>(limit: number) => ({
  items: [] as Item[],
  offset: 0,
  limit,
  total: 0,
  returned: 0,
  dropped: 0,
  complete: true,
});

const evidence = (result: ManagedMemberInspection) =>
  createEvidence(undefined, MANAGED_STATIC_EXAMPLE_PROVIDER, {
    operation: "inspect_managed_members",
    parameters: {},
    result,
    rawResult: null,
    limitations: result.limitations,
  });

const runtimeMembers = (): ManagedMemberInspection => {
  const result = emptyManagedMembers(
    "2".repeat(64),
    "11112222-3333-4444-9555-666677778888",
  );
  return {
    ...result,
    methods: {
      ...result.methods,
      items: [
        {
          token: "0x06000001",
          row_offset: 128,
          declaring_type_token: "0x02000001",
          declaring_type: "Example.Program",
          name: "Main",
          rva: 8192,
          impl_flags: 0,
          flags: 22,
          signature: {
            raw_length: 3,
            raw_sha256: "3".repeat(64),
            kind: "method",
            parse_status: "decoded",
            calling_convention: "default",
            generic_parameter_count: 0,
            parameter_count: 0,
            return_type: "void",
            parameter_types: [],
            field_type: null,
            issue: null,
          },
          body: {
            status: "present",
            header_format: "tiny",
            rva: 8192,
            file_offset: 512,
            max_stack: 8,
            init_locals: false,
            local_var_sig_token: null,
            il_size: 1,
            il_sha256: "4".repeat(64),
            normalized_il_sha256: "5".repeat(64),
            instruction_count: 1,
            decoded_instruction_count: 1,
            truncated_instructions: 0,
            opcode_counts: { ret: 1 },
            anchors: [],
            exception_regions: [],
            issue: null,
          },
        },
      ],
      total: 1,
      returned: 1,
    },
  };
};

/** Minimal valid managed member comparison request for public contracts. */
export const MANAGED_MEMBER_COMPARISON_EXAMPLE = {
  left: evidence(
    emptyManagedMembers("0".repeat(64), "00112233-4455-6677-8899-aabbccddeeff"),
  ),
  right: evidence(
    emptyManagedMembers("1".repeat(64), "ffeeddcc-bbaa-4988-9766-554433221100"),
  ),
  limits: {
    max_method_matches: 100,
    max_field_matches: 50,
    max_candidates: 25,
  },
};

const runtimeExampleEvidence = evidence(runtimeMembers());

/** Minimal valid managed decompiler reconstruction import request. */
export const MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE = {
  static_members: runtimeExampleEvidence,
  decompiler: {
    name: "ilspycmd",
    version: "9.1.0.7988",
    family: "ilspy",
    executable_sha256: null,
    options: ["--disable-updatecheck", "--type", "Example.Program"],
  },
  methods: [
    {
      token: "0x06000001",
      signature_sha256: "3".repeat(64),
      normalized_il_sha256: "5".repeat(64),
      reconstruction: {
        kind: "decompiled-csharp",
        language: "csharp",
        text: "internal static void Main() { }",
        source_path: "/examples/Example.Program.cs",
        start_line: 1,
        end_line: 1,
      },
    },
  ],
  notes: [
    "Synthetic example only; decompiler output is imported as inference.",
  ],
};

/** Minimal valid managed runtime-correlation planning request. */
export const MANAGED_RUNTIME_CORRELATION_EXAMPLE = {
  static_members: runtimeExampleEvidence,
  method: {
    token: "0x06000001",
    signature_sha256: "3".repeat(64),
    normalized_il_sha256: "5".repeat(64),
  },
  requested_effect: "attach",
  host: {
    os: "linux",
    clr_family: "dotnet",
    architecture: "x86_64",
  },
  bounds: {
    timeout_ms: 5_000,
    max_threads: 32,
    max_output_bytes: 65_536,
    allow_network: false,
    allow_ui: false,
  },
};
