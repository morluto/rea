import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { emulateFunctionInputSchema } from "../contracts/unicorn/unicornToolContracts.js";
import { validateEmulationHarness } from "./UnicornHarness.js";

const CODE = 0x1000000;
const STACK = 0x7f000000;

const baseInput = () =>
  emulateFunctionInputSchema.parse({
    architecture: "x86_64",
    function_bytes: "89f801f0c3",
    code_address: CODE,
    registers: { rdi: 40, rsi: 2 },
    stack_address: STACK,
    stack_size: 65536,
  });

describe("validateEmulationHarness", () => {
  it("accepts a well-formed harness", () => {
    expect(validateEmulationHarness(baseInput())).toEqual([]);
  });

  it("accepts a matching function digest", () => {
    const input = baseInput();
    const digest = createHash("sha256")
      .update(Buffer.from(input.function_bytes, "hex"))
      .digest("hex");
    expect(
      validateEmulationHarness({ ...input, function_sha256: digest }),
    ).toEqual([]);
  });

  it("rejects an unaligned code address", () => {
    const issues = validateEmulationHarness({
      ...baseInput(),
      code_address: CODE + 1,
    });
    expect(issues.map((issue) => issue.path)).toContainEqual(["code_address"]);
  });

  it("rejects an unaligned stack address", () => {
    const issues = validateEmulationHarness({
      ...baseInput(),
      stack_address: STACK + 8,
    });
    expect(issues.map((issue) => issue.path)).toContainEqual(["stack_address"]);
  });

  it("rejects an entry offset past the function bytes", () => {
    const issues = validateEmulationHarness({
      ...baseInput(),
      entry_offset: 5,
    });
    expect(issues.map((issue) => issue.path)).toContainEqual(["entry_offset"]);
  });

  it("rejects overlapping memory regions", () => {
    const issues = validateEmulationHarness({
      ...baseInput(),
      memory: [{ address: CODE, bytes: "00" }],
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.message).toMatch(/overlap/);
  });

  it("rejects a stub address inside a declared region", () => {
    const issues = validateEmulationHarness({
      ...baseInput(),
      stubs: { "0x1000000": 0 },
    });
    expect(issues.map((issue) => issue.path)).toContainEqual(["stubs"]);
  });

  it("rejects a mapped total above the address-space budget", () => {
    const issues = validateEmulationHarness({
      ...baseInput(),
      budgets: {
        instruction_cap: 1_000_000,
        timeout_ms: 30_000,
        address_space_bytes: 0x1000,
      },
    });
    expect(issues.map((issue) => issue.path)).toContainEqual([
      "budgets",
      "address_space_bytes",
    ]);
  });

  it("rejects a function digest mismatch", () => {
    const issues = validateEmulationHarness({
      ...baseInput(),
      function_sha256: "0".repeat(64),
    });
    expect(issues.map((issue) => issue.path)).toContainEqual([
      "function_sha256",
    ]);
  });
});
