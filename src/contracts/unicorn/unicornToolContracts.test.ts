import { describe, expect, it } from "vitest";

import { createEvidence } from "../../domain/evidence.js";
import {
  emulateFunctionInputSchema,
  emulateFunctionOutputSchema,
  UNICORN_TOOL_CONTRACTS,
} from "./unicornToolContracts.js";
import { UNICORN_PROVIDER_IDENTITY } from "../UnicornRelease.js";

const CODE = 0x1000000;
const STACK = 0x7f000000;

const emulateFunctionContract = () =>
  UNICORN_TOOL_CONTRACTS.find(
    (contract) => contract.name === "emulate_function",
  )!;

const baseInput = () => ({
  architecture: "x86_64",
  function_bytes: "89f801f0c3",
  code_address: CODE,
  registers: { rdi: 40, rsi: 2 },
  stack_address: STACK,
  stack_size: 65536,
});

describe("emulate_function contract", () => {
  it("declares one contract with the expected name and kind", () => {
    expect(UNICORN_TOOL_CONTRACTS.map((contract) => contract.name)).toEqual([
      "emulate_function",
    ]);
    const contract = emulateFunctionContract();
    expect(contract.kind).toBe("native-provider");
    expect(contract.requiresActiveTarget).toBe(false);
    expect(contract.description).toMatch(/stubbed and recorded/);
  });

  it("parses the contract example input with defaults applied", () => {
    const contract = emulateFunctionContract();
    const example = contract.examples[0]!.input;
    const parsed = emulateFunctionInputSchema.parse(example);
    expect(parsed.architecture).toBe("x86_64");
    expect(parsed.entry_offset).toBe(0);
    expect(parsed.budgets.instruction_cap).toBe(1_000_000);
    expect(parsed.stub_policy).toBe("record");
  });

  it("advertises the Evidence envelope, not the raw result, as its output", () => {
    const contract = emulateFunctionContract();
    const raw = emulateFunctionOutputSchema.parse({
      stop_reason: "returned",
      return_value: 42,
      registers: { rax: 42, rip: 0x0badf00d },
      memory_writes: [],
      memory_diff_truncated: false,
      calls_hit: [],
      instructions_executed: 3,
      engine: { name: "unicorn", version: "2.1.2" },
    });
    // The raw result alone must not satisfy the advertised output schema:
    // MCP clients validate structuredContent against it, and the tool
    // returns a complete Evidence record.
    expect(() => contract.outputSchema.parse(raw)).toThrow();
    const evidence = createEvidence(undefined, UNICORN_PROVIDER_IDENTITY, {
      operation: "emulate_function",
      parameters: {},
      result: raw,
    });
    const parsed = contract.outputSchema.parse(evidence);
    expect(parsed.normalized_result).toEqual(raw);
  });

  it("rejects a non-x86_64 architecture", () => {
    expect(() =>
      emulateFunctionInputSchema.parse({
        ...baseInput(),
        architecture: "aarch64",
      }),
    ).toThrow();
  });

  it("rejects odd-length hex function bytes", () => {
    expect(() =>
      emulateFunctionInputSchema.parse({
        ...baseInput(),
        function_bytes: "89f",
      }),
    ).toThrow();
  });

  it("rejects derived registers", () => {
    expect(() =>
      emulateFunctionInputSchema.parse({
        ...baseInput(),
        registers: { rip: CODE },
      }),
    ).toThrow();
  });

  it("rejects negative addresses and over-max budgets", () => {
    expect(() =>
      emulateFunctionInputSchema.parse({
        ...baseInput(),
        code_address: -1,
      }),
    ).toThrow();
    expect(() =>
      emulateFunctionInputSchema.parse({
        ...baseInput(),
        budgets: {
          instruction_cap: 1_000_000_001,
          timeout_ms: 30_000,
          address_space_bytes: 3 * 1024 * 1024 * 1024,
        },
      }),
    ).toThrow();
  });

  it("rejects non-hex stub keys", () => {
    expect(() =>
      emulateFunctionInputSchema.parse({
        ...baseInput(),
        stubs: { "not-an-address": 0 },
      }),
    ).toThrow();
  });

  it("parses a complete run output", () => {
    const parsed = emulateFunctionOutputSchema.parse({
      stop_reason: "returned",
      return_value: 42,
      registers: { rax: 42, rsp: STACK + 65536 - 8, rip: 0x0badf00d },
      memory_writes: [],
      memory_diff_truncated: false,
      calls_hit: [],
      instructions_executed: 3,
      engine: { name: "unicorn", version: "2.1.2" },
    });
    expect(parsed.return_value).toBe(42);
  });
});
