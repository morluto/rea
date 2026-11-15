/**
 * Successful bridge replies the fake Hopper serves. Each must satisfy the
 * reply contract REA applies to the real bridge
 * (src/hopper/HopperReplyContracts.ts).
 */

/** The one procedure the fake reports, in the bridge's identity shape. */
const FIXTURE_PROCEDURE = Object.freeze({
  address: "0x1000",
  name: "fixture",
  symbol: null,
  classification: null,
  body: Object.freeze({
    available: false,
    reason: "The fixture has no function body-extent observation.",
  }),
});

/**
 * Reply factories keyed by bridge method. The keys are the single list of
 * methods the fake answers, so the contract test covers every reply. A
 * factory may read the request's params; without them it answers the
 * default request.
 */
export const FAKE_HOPPER_REPLIES = Object.freeze({
  list_segments: () => [
    {
      name: "__TEXT",
      start: "0x1000",
      end: "0x2000",
      // The real bridge cannot read permissions from Hopper's public API.
      readable: null,
      writable: null,
      executable: null,
      permissions: {
        available: false,
        reason:
          "Hopper's public Python API does not expose segment or section permissions",
      },
      provenance: "hopper-public-python-api",
      sections: [],
    },
  ],
  list_documents: () => ["fixture"],
  list_procedures: () => [{ address: "0x1000", value: "fixture" }],
  list_strings: () => [{ address: "0x1000", value: "fixture" }],
  procedure_pseudo_code: () => "return 0;",
  rea_caller_scan_target: () => ({
    target: FIXTURE_PROCEDURE,
    instructions: ["0x1000"],
    instructions_complete: true,
  }),
  rea_caller_base: () => ({
    target: FIXTURE_PROCEDURE,
    instructions: ["0x1000"],
    instructions_complete: true,
    callers: [],
    callers_complete: true,
  }),
  rea_caller_scan_page: () => ({
    start: 0,
    next: 0,
    total: 0,
    oversized: false,
    items: [],
  }),
  analyze_function: () => ({
    procedure: {
      address: "0x1000",
      name: "fixture",
      classification: null,
      body: {
        available: false,
        reason: "The fixture has no function body-extent observation.",
      },
      signature: null,
      locals: [],
    },
    pseudocode: "return 0;",
    assembly: ["ret"],
    comments: [],
    callers: [],
    callees: [],
    incoming_references: [],
    outgoing_references: [],
    referenced_strings: [],
    referenced_names: [],
    basic_blocks: [{ start: "0x1000", end: "0x1001", successors: [] }],
    native_api: null,
    native_value_flow: null,
    limitations: [],
  }),
  search_strings: () => [],
  search_procedures: () => [],
  xrefs: () => ["0x1000"],
  resolve_containing_procedure: (params = {}) => ({
    query_address:
      typeof params.address === "string" ? params.address : "0x1000",
    found: true,
    procedure: FIXTURE_PROCEDURE,
  }),
  procedure_references: (params = {}) => ({
    procedure: FIXTURE_PROCEDURE,
    direction: params.direction === "incoming" ? "incoming" : "outgoing",
    reference_kinds_available: false,
    unresolved_calls: [],
    references: [],
  }),
});

export const fakeHopperReply = (method, params = {}) =>
  Object.hasOwn(FAKE_HOPPER_REPLIES, method)
    ? FAKE_HOPPER_REPLIES[method](params)
    : undefined;

/** Every method fakeHopperReply answers, derived from the factories. */
export const FAKE_HOPPER_REPLY_METHODS = Object.freeze(
  Object.keys(FAKE_HOPPER_REPLIES),
);
