import { describe, expect, it } from "vitest";
import { ok } from "../../../src/domain/result.js";
import {
  compactReference,
  compactInstruction,
  compactCallTargets,
} from "../../../src/domain/native/nativeInstruction.fixture.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";

describe("compact Ghidra reference MCP evidence", () => {
  it("retains access kind, non-primary analyzer references and call-target provenance", async () => {
    const base = {
      ...compactReference(),
      call: false,
      computed: false,
      data: true,
    };
    const references = [
      { ...base, type: "DATA", primary: true, operand_index: 1 },
      { ...base, type: "READ", primary: true, read: true, operand_index: 1 },
      { ...base, type: "WRITE", primary: false, write: true, operand_index: 0 },
    ];
    const outputs = {
      inspect_native_instruction: compactInstruction(references),
      resolve_native_call_targets: compactCallTargets([compactReference()]),
    };
    const harness = await connectGhidraMcp(
      "ghidra-compact-provenance",
      (operation) => {
        if (
          operation !== "inspect_native_instruction" &&
          operation !== "resolve_native_call_targets"
        )
          throw new TypeError(`Unexpected operation: ${operation}`);
        return Promise.resolve(ok(outputs[operation]));
      },
    );
    try {
      for (const name of [
        "inspect_native_instruction",
        "resolve_native_call_targets",
      ] as const) {
        const result = await harness.mcp.callTool({
          name,
          arguments: { address: "0x401000" },
        });
        expect(result.isError).not.toBe(true);
        const evidence = sessionEvidence(
          harness.session,
          result.structuredContent,
        );
        expect(evidence.normalized_result).toEqual(outputs[name]);
      }
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("preserves empty references and unresolved targets without manufacturing provenance", async () => {
    const outputs = {
      inspect_native_instruction: compactInstruction(),
      resolve_native_call_targets: compactCallTargets(),
    };
    const harness = await connectGhidraMcp(
      "ghidra-compact-unknown",
      (operation) => {
        if (
          operation !== "inspect_native_instruction" &&
          operation !== "resolve_native_call_targets"
        )
          throw new TypeError(`Unexpected operation: ${operation}`);
        return Promise.resolve(ok(outputs[operation]));
      },
    );
    try {
      for (const name of [
        "inspect_native_instruction",
        "resolve_native_call_targets",
      ] as const) {
        const result = await harness.mcp.callTool({
          name,
          arguments: { address: "0x401000" },
        });
        expect(result.isError).not.toBe(true);
        expect(
          sessionEvidence(harness.session, result.structuredContent)
            .normalized_result,
        ).toEqual(outputs[name]);
      }
    } finally {
      await harness.close();
    }
  }, 30_000);
});
