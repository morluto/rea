import type { JsonValue } from "./jsonValue.js";

export const ghidraFunctionClassification = () => ({
  external: false,
  thunk: false,
  thunk_target: null,
  provenance: "ghidra-function-manager" as const,
});

export const ghidraFunctionIdentity = () => ({
  address: "0x401000",
  name: "fixture_main",
  classification: ghidraFunctionClassification(),
});

const ghidraReferenceKind = () => ({
  available: true as const,
  provenance: "ghidra-reference-manager" as const,
  type: "DATA",
  flow: false,
  call: false,
  jump: false,
  data: true,
  read: true,
  write: false,
  indirect: false,
  computed: false,
  conditional: false,
  terminal: false,
  primary: true,
  operand_index: 0,
  external: false,
});

export const ghidraReferenceEdge = () => ({
  source_address: "0x401001",
  target_address: "0x402000",
  source_procedure: ghidraFunctionIdentity(),
  target_procedure: null,
  kind: ghidraReferenceKind(),
});

export const ghidraBounded = (items: readonly JsonValue[]) => ({
  items: [...items],
  total: items.length,
  returned: items.length,
  truncated: false,
  next_offset: null,
});

export const ghidraNativeApiBoundary = (mappingsTruncated = false) => ({
  available: true as const,
  provenance: "ghidra-high-function",
  signature_source: "analysis",
  calling_convention: "__cdecl",
  return_type: {
    role: "return" as const,
    ordinal: null,
    name: null,
    data_type: "int",
    size_bytes: 4,
    storage: "EAX:4",
    confidence: "medium" as const,
    evidence: [
      {
        kind: "signature-source" as const,
        source: "ghidra-function-manager",
        detail: "Function signature source is analysis.",
      },
      {
        kind: "decompiler-type" as const,
        source: "ghidra-high-function",
        detail: "HighFunction recovered data type int.",
      },
    ],
    decompiler_artifacts: [
      "recovered-signature" as const,
      "register-or-stack-storage" as const,
    ],
  },
  parameters: [],
  parameters_truncated: false,
  jump_tables: [
    {
      dispatch_address: "0x401010",
      data_sources: [
        {
          address: "0x403000",
          provenance: "ghidra-decompiler-load-table" as const,
          entry_size_bytes: 4,
          entry_count: 2,
          confidence: "high" as const,
          evidence: [
            {
              kind: "jump-table" as const,
              source: "ghidra-high-function",
              detail: "Decompiler load table starts at 0x403000.",
            },
          ],
        },
      ],
      data_sources_truncated: false,
      mappings: [
        {
          case_value: 0,
          target_address: "0x401020",
          data_addresses: ["0x403000"],
          confidence: "medium" as const,
          evidence: [
            {
              kind: "jump-table" as const,
              source: "ghidra-high-function",
              detail: "Recovered target 0x401020 from dispatch 0x401010.",
            },
          ],
        },
      ],
      mappings_truncated: mappingsTruncated,
      limitations: [],
    },
  ],
  jump_tables_truncated: false,
  pseudocode: {
    classification: "decompiler-generated-non-source" as const,
    compilable: false as const,
  },
  decompiler_artifacts: [
    "recovered-signature" as const,
    "register-and-stack-variables" as const,
    "compiler-generated-control-flow" as const,
    "pointer-arithmetic" as const,
    "pseudocode" as const,
  ],
  limitations: [
    "Pseudocode is neither original source nor guaranteed to compile.",
  ],
});

export const ghidraFunctionDossier = (
  includeAssembly = true,
  mappingsTruncated = false,
): JsonValue => {
  const pseudocode = "int fixture_main(void) { return 42; }";
  return {
    procedure: {
      ...ghidraFunctionIdentity(),
      signature: "int fixture_main(void)",
      locals: [],
    },
    pseudocode: {
      text: pseudocode,
      total_chars: [...pseudocode].length,
      returned_chars: [...pseudocode].length,
      truncated: false,
      next_offset: null,
    },
    assembly: ghidraBounded(
      includeAssembly ? ["0x401000: CALL 0x401020", "0x401005: RET"] : [],
    ),
    comments: ghidraBounded([]),
    callers: ghidraBounded([]),
    callees: ghidraBounded([]),
    incoming_references: ghidraBounded([]),
    outgoing_references: ghidraBounded([ghidraReferenceEdge()]),
    referenced_strings: ghidraBounded([
      {
        address: "0x402000",
        value: "inventory fixture",
        source_address: "0x401001",
      },
    ]),
    referenced_names: ghidraBounded([]),
    basic_blocks: ghidraBounded([
      { start: "0x401000", end: "0x401006", successors: [] },
    ]),
    instruction_scan: { scanned: 2, truncated: false },
    native_api: ghidraNativeApiBoundary(mappingsTruncated),
    limitations: [
      "Unresolved computed or indirect flows without target addresses are not represented as reference edges.",
      "Thunk and external classifications are Ghidra FunctionManager observations; they do not resolve targetless calls.",
      "Pseudocode and assembly are Ghidra-specific representations, not original source or Hopper-equivalent text.",
    ],
  };
};
