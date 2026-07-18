export const inspectionLimits = {
  referenceOffset: 0,
  referenceLimit: 100,
  resourceOffset: 0,
  resourceLimit: 100,
  attributeOffset: 0,
  attributeLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

export const memberLimits = {
  typeOffset: 0,
  typeLimit: 100,
  methodOffset: 0,
  methodLimit: 100,
  fieldOffset: 0,
  fieldLimit: 100,
  memberRefOffset: 0,
  memberRefLimit: 100,
  edgeOffset: 0,
  edgeLimit: 100,
  instructionAnchorLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
  maxMethodBodyBytes: 1024 * 1024,
  maxMethodInstructions: 1_000,
};

export const nativeBoundaryLimits = {
  moduleRefOffset: 0,
  moduleRefLimit: 100,
  importOffset: 0,
  importLimit: 100,
  implementationOffset: 0,
  implementationLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

export const applicationGraphLimits = {
  max_types: 100,
  max_methods: 100,
  max_fields: 100,
  max_pinvoke_imports: 100,
  max_native_implementations: 100,
};

export const comparisonLimits = {
  max_method_matches: 100,
  max_field_matches: 100,
  max_candidates: 20,
};

export const defaultIlBody = Buffer.from([
  0x32, 0x02, 0x7b, 0x01, 0x00, 0x00, 0x04, 0x28, 0x01, 0x00, 0x00, 0x0a, 0x2a,
]);

export function functionDossier(name) {
  const emptyPage = {
    items: [],
    total: 0,
    returned: 0,
    truncated: false,
    next_offset: null,
  };
  return {
    procedure: {
      address: "0x401000",
      name,
      classification: {
        external: false,
        thunk: false,
        thunk_target: null,
        provenance: "synthetic-provider",
      },
      signature: null,
      locals: [],
    },
    pseudocode: {
      text: "",
      total_chars: 0,
      returned_chars: 0,
      truncated: false,
      next_offset: null,
    },
    assembly: emptyPage,
    comments: emptyPage,
    callers: emptyPage,
    callees: emptyPage,
    incoming_references: emptyPage,
    outgoing_references: emptyPage,
    referenced_strings: emptyPage,
    referenced_names: emptyPage,
    basic_blocks: emptyPage,
    instruction_scan: { scanned: 0, truncated: false },
    limitations: [],
  };
}
