/**
 * Successful bridge replies the fake Ghidra serves. Each must satisfy the
 * contract REA applies to the real Java bridge: the handshake
 * (src/ghidra/GhidraSessionValues.ts), inventory and naming results
 * (src/ghidra/GhidraInventoryValues.ts) and the shutdown acknowledgement.
 * tests/boundary/providers/ghidra/fakeGhidraReplyContracts.test.ts checks
 * every reply here, so contract drift fails there instead of surfacing as an
 * unreadable reply in the workflows that run against the fake.
 */

// One owner for the fixture's memory blocks. Each reply uses the production
// bridge's end convention: list_segments reports an exclusive end, byte-search
// coverage an inclusive one, and address_to_file_offset tests containment.
const TEXT_BLOCK = {
  name: ".text",
  start: 0x1000n,
  size: 0x100n,
  fileOffset: 0n,
};
const BSS_BLOCK = {
  name: ".bss",
  start: 0x2000n,
  size: 0x10n,
  fileOffset: null,
};
const FIXTURE_BLOCKS = [TEXT_BLOCK, BSS_BLOCK];
const hex = (value) => `0x${value.toString(16)}`;

/** Methods the bridge drops from a read-only (loopback TCP) handshake. */
const MUTATING_METHODS = [
  "annotate_native_function",
  "define_native_data_types",
  "set_address_name",
  "set_addresses_names",
];

/** Every method the fake's handshake advertises on a writable bridge. */
export const FAKE_GHIDRA_CAPABILITIES = Object.freeze([
  "read_binary_inventory_summary",
  "ping",
  "shutdown",
  "inspect_native_load_image",
  "read_bytes",
  "search_bytes",
  "address_to_file_offset",
  "address_name",
  "list_documents",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "procedure_address",
  "resolve_containing_procedure",
  "search_procedures",
  "search_strings",
  "set_address_name",
  "set_addresses_names",
  "annotate_native_function",
  "define_native_data_types",
  "inspect_native_data_type",
  "inspect_native_instruction",
  "resolve_native_call_targets",
  "analyze_function",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "procedure_pseudo_code",
  "read_function_instructions",
  "procedure_references",
  "xrefs",
]);

/** The ping result that proves the selected Program's session identity. */
export const fakeGhidraSessionInfo = ({
  runId,
  providerVersion,
  profileDigest,
  targetSha256,
  transport,
  timedOut,
}) => ({
  name: "REA Ghidra bridge",
  run_id: runId,
  profile_digest: profileDigest,
  provider: { id: "ghidra", version: providerVersion },
  read_only: transport !== "unix-socket",
  analysis_complete: !timedOut,
  analysis_timed_out: timedOut,
  capabilities: FAKE_GHIDRA_CAPABILITIES.filter(
    (value) => transport === "unix-socket" || !MUTATING_METHODS.includes(value),
  ),
  target: {
    name: "fixture",
    language_id: "x86:LE:64:default",
    compiler_spec_id: "gcc",
    image_base: "0x1000",
    default_address_space: "ram",
    sha256: targetSha256,
  },
});

/** The bridge's acknowledgement that its loop ended with an ephemeral project. */
export const FAKE_GHIDRA_SHUTDOWN_ACK = Object.freeze({
  shutdown: true,
  project_ephemeral: true,
});

/** A single-address edit that the bridge applied. */
export const fakeGhidraAddressNameReply = (params = {}) => ({
  results: {
    [typeof params.address === "string" ? params.address : "0x1000"]: true,
  },
  failures: {},
  conflicts: [],
});

/** The address_to_file_offset reply or remote error for one address. */
export const fakeGhidraFileOffsetReply = (address) => {
  const digits = /^(?:0[xX])?([0-9a-fA-F]+)$/u.exec(address)?.[1];
  const failure = (code, message) => ({ ok: false, error: { code, message } });
  if (digits === undefined)
    return failure("invalid_request", `Invalid address: ${address}`);
  const value = BigInt(`0x${digits}`);
  const at = hex(value);
  const block = FIXTURE_BLOCKS.find(
    ({ start, size }) => value >= start && value < start + size,
  );
  if (block === undefined)
    return failure(
      "address_unmapped",
      `Address ${at} is outside every Ghidra memory block`,
    );
  if (block.fileOffset === null)
    return failure(
      "address_uninitialized",
      `Address ${at} is in uninitialized Ghidra memory block ${block.name}`,
    );
  return {
    ok: true,
    result: {
      address: at,
      file_offset: Number(block.fileOffset + value - block.start),
    },
  };
};

const nameItem = () => ({
  address: "0x1000",
  value: "fixture_main",
  symbol: {
    primary: true,
    dynamic: false,
    external: false,
    type: "function",
    source: "analysis",
  },
});

const procedureItem = () => ({
  address: "0x1000",
  value: "fixture_main",
  procedure: { external: false, thunk: false, thunk_target: null },
});

const segmentItem = () => ({
  name: TEXT_BLOCK.name,
  start: hex(TEXT_BLOCK.start),
  end: hex(TEXT_BLOCK.start + TEXT_BLOCK.size),
  readable: true,
  writable: false,
  executable: true,
  permissions: { available: true, source: "ghidra-memory-block" },
  provenance: "ghidra-memory-block",
  address_space: "ram",
  image_base: "0x1000",
  initialized: true,
  overlay: false,
  sections: [],
});

/** The bridge's canonical identity for the fixture's one function. */
const procedureIdentity = () => ({
  address: "0x1000",
  name: "fixture_main",
  symbol: nameItem().symbol,
  classification: {
    ...procedureItem().procedure,
    provenance: "ghidra-function-manager",
  },
  body: {
    available: true,
    provenance: "ghidra-function-body-address-set",
    ranges: [{ start: "0x1000", end: "0x1005" }],
    total_bytes: 6,
    span_bytes: 6,
    non_contiguous: false,
    contains_entry: true,
  },
});

/** One list_strings item in the bridge's string-observation shape. */
export const fakeGhidraStringItem = (address, value) => ({
  address,
  value,
  string: {
    encoding: "UTF-8",
    termination: "present_or_not_required",
    byte_length: Buffer.byteLength(value, "utf8") + 1,
  },
});

const searchBytesReply = (params) => {
  const continued = params.cursor === "fixture-second-page";
  const paged = params.limit === 1 && !continued;
  const addresses = continued
    ? ["0x1005"]
    : paged
      ? ["0x1000"]
      : ["0x1000", "0x1005"];
  return {
    matches: addresses.map((address) => ({
      address,
      segment: ".text",
      file_offset: address === "0x1000" ? 0 : 5,
      procedure: { address: "0x1000", name: "fixture_main" },
    })),
    searched: {
      blocks: [
        {
          segment: ".text",
          start: continued ? "0x1005" : "0x1000",
          end: "0x1009",
          bytes: continued ? 5 : 10,
        },
      ],
      bytes: continued ? 5 : 10,
      skipped_uninitialized: [
        {
          segment: BSS_BLOCK.name,
          start: hex(BSS_BLOCK.start),
          end: hex(BSS_BLOCK.start + BSS_BLOCK.size - 1n),
          bytes: Number(BSS_BLOCK.size),
        },
      ],
      skipped_not_loaded: [],
      skipped_overlays: [],
    },
    complete: !paged,
    next_cursor: paged ? "fixture-second-page" : null,
  };
};

/**
 * Inventory reply factories keyed by bridge method. The keys are the single
 * list of inventory methods the fake answers, so the contract test covers
 * every reply. A factory may read the request's params.
 */
export const FAKE_GHIDRA_INVENTORY_REPLIES = Object.freeze({
  read_binary_inventory_summary: () => ({
    document: "fixture",
    segments: fakeGhidraInventoryReply("list_segments"),
    procedure_count: fakeGhidraInventoryReply("list_procedures").length,
    string_count: fakeGhidraInventoryReply("list_strings").length,
  }),
  search_bytes: searchBytesReply,
  address_name: () => "fixture_main",
  list_documents: () => ["fixture"],
  list_names: () => [nameItem()],
  list_procedures: () => [procedureItem()],
  list_segments: () => [segmentItem()],
  list_strings: () => [fakeGhidraStringItem("0x2000", "fixture value")],
  procedure_address: () => "0x1000",
  resolve_containing_procedure: () => ({
    query_address: "0x1001",
    found: true,
    procedure: procedureIdentity(),
  }),
  search_procedures: () => [procedureItem()],
  search_strings: () => [fakeGhidraStringItem("0x2000", "fixture value")],
});

export const fakeGhidraInventoryReply = (method, params = {}) =>
  Object.hasOwn(FAKE_GHIDRA_INVENTORY_REPLIES, method)
    ? FAKE_GHIDRA_INVENTORY_REPLIES[method](params)
    : undefined;

/** Every inventory method fakeGhidraInventoryReply answers. */
export const FAKE_GHIDRA_INVENTORY_METHODS = Object.freeze(
  Object.keys(FAKE_GHIDRA_INVENTORY_REPLIES),
);
