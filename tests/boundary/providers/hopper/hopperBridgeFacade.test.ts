import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

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
  strings: z.strictObject({ "0x401234": z.literal("fixture string") }),
  inventory_replies: z.array(
    z.strictObject({
      id: z.number().int(),
      result: z.array(
        z.strictObject({ address: z.string(), value: z.string() }),
      ),
    }),
  ),
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
    expect(stdout).not.toContain("supersecret");
    expect(result.analysis_guard.message).toContain(
      "requires completed Hopper background analysis",
    );
  });
});
