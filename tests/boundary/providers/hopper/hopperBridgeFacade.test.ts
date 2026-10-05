import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OFFICIAL_TOOL_CONTRACTS } from "../../../../src/contracts/toolContracts.js";

const execute = promisify(execFile);
const bridgePath = new URL(
  "../../../../bridge/hopper_bridge.py",
  import.meta.url,
);
const probePath = new URL(
  "../../../fixtures/hopperBridgeFacadeProbe.py",
  import.meta.url,
);

const probeResultSchema = z.strictObject({
  imported_without_hopper: z.strictObject({
    type: z.literal("CapabilityUnavailableError"),
    diagnostic_type: z.literal("capability_unavailable"),
  }),
  current_document: z.literal("fixture"),
  current_address: z.literal("0x401000"),
  containing_procedure: z.strictObject({
    query_address: z.literal("0x401000"),
    found: z.literal(true),
    procedure: z.strictObject({
      address: z.literal("0x401000"),
      name: z.literal("fixture-procedure"),
      classification: z.null(),
      body: z.strictObject({
        available: z.literal(false),
        reason: z.string(),
      }),
    }),
  }),
  procedure_info: z.strictObject({
    name: z.literal("fixture-procedure"),
    entrypoint: z.literal("0x401000"),
    basicblock_count: z.literal(1),
    length: z.number(),
    signature: z.literal("int fixture-procedure()"),
    locals: z.array(z.unknown()),
    classification: z.null(),
    body: z.strictObject({
      available: z.literal(false),
      reason: z.string(),
    }),
  }),
  strings: z.strictObject({ "0x401234": z.literal("fixture string") }),
  procedure_references: z.strictObject({
    procedure: z.strictObject({
      address: z.literal("0x401000"),
      name: z.literal("fixture-procedure"),
      classification: z.null(),
      body: z.strictObject({
        available: z.literal(false),
        reason: z.string(),
      }),
    }),
    direction: z.literal("outgoing"),
    reference_kinds_available: z.literal(false),
    unresolved_calls: z.array(z.unknown()),
    references: z.array(z.unknown()),
  }),
  inventory_replies: z.array(
    z.strictObject({
      id: z.number().int(),
      result: z.array(
        z.strictObject({ address: z.string(), value: z.string() }),
      ),
    }),
  ),
  provider_faults: z.array(
    z.strictObject({
      id: z.literal(1),
      error: z.strictObject({
        code: z.literal(-32000),
        message: z.string(),
        type: z.literal("bridge_exception"),
      }),
    }),
  ),
  malformed_requests: z.array(z.unknown()),
  session_document_reused: z.literal(true),
  shared_document_shutdown: z.strictObject({
    shutdown: z.literal(true),
    analysis_stopped: z.literal(false),
    document_closed: z.literal(false),
    document_retained: z.literal(true),
  }),
  analysis_guard: z.strictObject({
    type: z.literal("CapabilityUnavailableError"),
    diagnostic_type: z.literal("capability_unavailable"),
    message: z.string(),
  }),
  bridge_messages: z.tuple([
    z.strictObject({
      id: z.literal(7),
      event: z.strictObject({
        type: z.literal("progress"),
        phase: z.literal("hopper_bridge"),
        completed: z.literal(0),
        total: z.literal(1),
        message: z.literal("Hopper bridge started request"),
      }),
    }),
    z.strictObject({
      id: z.literal(7),
      event: z.strictObject({
        type: z.literal("diagnostic"),
        error: z.strictObject({
          code: z.literal(-32000),
          message: z.literal("RuntimeError: Hopper bridge operation failed"),
          type: z.literal("bridge_exception"),
        }),
      }),
    }),
    z.strictObject({
      id: z.literal(7),
      error: z.strictObject({
        code: z.literal(-32000),
        message: z.literal("RuntimeError: Hopper bridge operation failed"),
        type: z.literal("bridge_exception"),
      }),
    }),
  ]),
  invalid_id_response: z.strictObject({
    id: z.literal(0),
    error: z.strictObject({
      code: z.literal(-32000),
      message: z.literal("Invalid Hopper bridge request"),
      type: z.literal("invalid_request"),
    }),
  }),
});

describe("Hopper API facade", () => {
  it("imports without Hopper globals and gates exhaustive work during analysis", async () => {
    const { stdout } = await execute(
      "python3",
      [probePath.pathname, bridgePath.pathname],
      {
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 1_024 * 1_024,
      },
    );
    const result = probeResultSchema.parse(JSON.parse(stdout));
    for (const [name, value] of [
      ["resolve_containing_procedure", result.containing_procedure],
      ["procedure_references", result.procedure_references],
      ["procedure_info", result.procedure_info],
    ] as const) {
      const contract = OFFICIAL_TOOL_CONTRACTS.find(
        (candidate) => candidate.name === name,
      );
      if (contract === undefined) throw new Error(`missing ${name} contract`);
      const parsed = contract.outputSchema.shape.result.safeParse(value);
      if (!parsed.success) throw new Error(`${name}: ${parsed.error.message}`);
      expect(parsed.success, name).toBe(true);
    }
    expect(result.provider_faults.map((reply) => reply.error.message)).toEqual([
      "TypeError: Hopper bridge operation failed",
      "ValueError: Hopper bridge operation failed",
      "KeyError: Hopper bridge operation failed",
    ]);
    expect(result.malformed_requests).toEqual([
      ...[0, 0, 0, 0, 0, 2, 3, 0, 4, 5, 6, 7].map((id) => ({
        id,
        error: {
          code: -32000,
          type: "invalid_request",
          message: "Invalid Hopper bridge request",
        },
      })),
      {
        id: 8,
        error: {
          code: -32000,
          type: "authorization",
          message: "Invalid bridge capability",
        },
      },
      { id: 9, result: "0x401000" },
    ]);
    expect(result.inventory_replies).toEqual([
      {
        id: 1,
        result: [
          { address: "0x2", value: "string-2" },
          { address: "0x10", value: "string-16" },
          { address: "0x100", value: "string-256" },
        ],
      },
      {
        id: 2,
        result: [
          { address: "0x2", value: "name-2" },
          { address: "0x10", value: "name-16" },
          { address: "0x100", value: "name-256" },
        ],
      },
      { id: 3, result: [{ address: "0x10", value: "string-16" }] },
      { id: 4, result: [{ address: "0x10", value: "name-16" }] },
      { id: 5, result: [] },
      { id: 6, result: [] },
    ]);
    expect(result.procedure_references).toEqual({
      procedure: {
        address: "0x401000",
        name: "fixture-procedure",
        classification: null,
        body: {
          available: false,
          reason:
            "Hopper's public Python API does not expose complete function body ranges",
        },
      },
      direction: "outgoing",
      reference_kinds_available: false,
      unresolved_calls: [],
      references: [],
    });
    expect(result.containing_procedure).toEqual({
      query_address: "0x401000",
      found: true,
      procedure: {
        address: "0x401000",
        name: "fixture-procedure",
        classification: null,
        body: {
          available: false,
          reason:
            "Hopper's public Python API does not expose complete function body ranges",
        },
      },
    });
    expect(result.procedure_info).toEqual({
      name: "fixture-procedure",
      entrypoint: "0x401000",
      basicblock_count: 1,
      length: 4,
      signature: "int fixture-procedure()",
      locals: [],
      classification: null,
      body: {
        available: false,
        reason:
          "Hopper's public Python API does not expose complete function body ranges",
      },
    });
    expect(stdout).not.toContain("supersecret");
    expect(result.analysis_guard.message).toContain(
      "requires completed Hopper background analysis",
    );
  });
});
