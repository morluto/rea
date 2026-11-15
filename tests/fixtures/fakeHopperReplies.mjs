/**
 * Successful bridge replies the fake Hopper serves. Each must satisfy the
 * reply contract REA applies to the real bridge
 * (src/hopper/HopperReplyContracts.ts).
 */
export const fakeHopperReply = (method) => {
  switch (method) {
    case "list_segments":
      return [
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
      ];
    case "list_documents":
      return ["fixture"];
    case "list_procedures":
      return [{ address: "0x1000", value: "fixture" }];
    case "list_strings":
      return [{ address: "0x1000", value: "fixture" }];
    case "procedure_pseudo_code":
      return "return 0;";
    case "rea_caller_scan_target":
      return {
        target: {
          address: "0x1000",
          name: "fixture",
          symbol: null,
          classification: null,
          body: {
            available: false,
            reason: "The fixture has no function body-extent observation.",
          },
        },
        instructions: ["0x1000"],
        instructions_complete: true,
      };
    case "rea_caller_base":
      return {
        target: {
          address: "0x1000",
          name: "fixture",
          symbol: null,
          classification: null,
          body: {
            available: false,
            reason: "The fixture has no function body-extent observation.",
          },
        },
        instructions: ["0x1000"],
        instructions_complete: true,
        callers: [],
        callers_complete: true,
      };
    case "rea_caller_scan_page":
      return {
        start: 0,
        next: 0,
        total: 0,
        oversized: false,
        items: [],
      };
    case "analyze_function": {
      return {
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
      };
    }
    case "search_strings":
    case "search_procedures":
      return [];
    case "xrefs":
      return ["0x1000"];
    default:
      return undefined;
  }
};

/** Every method fakeHopperReply answers. */
export const FAKE_HOPPER_REPLY_METHODS = [
  "list_segments",
  "list_documents",
  "list_procedures",
  "list_strings",
  "procedure_pseudo_code",
  "rea_caller_scan_target",
  "rea_caller_base",
  "rea_caller_scan_page",
  "analyze_function",
  "search_strings",
  "search_procedures",
  "xrefs",
];
