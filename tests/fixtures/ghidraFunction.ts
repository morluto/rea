import type { JsonValue } from "../../src/domain/jsonValue.js";

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

export const ghidraFunctionDossier = (includeAssembly = true): JsonValue => {
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
    limitations: [
      "Unresolved computed or indirect flows without target addresses are not represented as reference edges.",
      "Thunk and external classifications are Ghidra FunctionManager observations; they do not resolve targetless calls.",
      "Pseudocode and assembly are Ghidra-specific representations, not original source or Hopper-equivalent text.",
    ],
  };
};
