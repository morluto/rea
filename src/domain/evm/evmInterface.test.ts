import { expect, it } from "vitest";
import {
  evmInterfaceSchema,
  inspectEvmInterfaceInputSchema,
  selectedEvmProducerLimits,
} from "./evmInterface.js";
import { SOLC_JSON_LIMITS } from "./solcCompilerJson.js";
import { evmInterfaceFixture } from "../../../tests/fixtures/evm/interface.js";

it("rejects compiler identities no admitted carrier could contain", () => {
  const result = inspectEvmInterfaceInputSchema.safeParse({
    path: "/carrier.json",
    encoding: "solc-json",
    compiler_selection: {
      source_unit: "a".repeat(SOLC_JSON_LIMITS.inputBytes + 1),
      contract_name: "C",
      bytecode_kind: "creation",
    },
  });
  expect(result.success).toBe(false);
});

it("defaults the file limit to the selected reply budget until explicitly overridden", () => {
  expect(selectedEvmProducerLimits({ output_bytes: 64 }).file_bytes).toBe(64);
  expect(
    selectedEvmProducerLimits({ output_bytes: 64, file_bytes: 128 }).file_bytes,
  ).toBe(128);
});

it("accepts historical metadata omission as an unknown facet without changing the source", () => {
  const value = evmInterfaceFixture();
  const { metadata: _metadata, ...oldBytecode } = value.bytecode;
  const old = { ...value, bytecode: oldBytecode };
  expect(evmInterfaceSchema.parse(old).bytecode.metadata).toBeNull();
  expect(old.bytecode).not.toHaveProperty("metadata");
});

it.each(["byte-count", "body-offset", "selector", "authenticity"])(
  "rejects false interface evidence: %s",
  (problem) => {
    const value = evmInterfaceFixture();
    const raw = {
      ...value,
      ...(problem === "authenticity"
        ? {
            bytecode: {
              ...value.bytecode,
              deployment_authenticity: "verified",
            },
          }
        : {}),
    };
    if (problem === "byte-count") raw.bytecode.bytes++;
    if (problem === "body-offset" || problem === "selector")
      raw.functions.push({
        selector: problem === "selector" ? "bad" : "0xaabbccdd",
        bytecode_offset: problem === "body-offset" ? 5 : 0,
        dispatch: "abi",
        inferred_arguments: null,
        inferred_state_mutability: null,
      });
    expect(evmInterfaceSchema.safeParse(raw).success).toBe(false);
  },
);
