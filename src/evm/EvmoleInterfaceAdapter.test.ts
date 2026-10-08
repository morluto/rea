import { expect, it } from "vitest";
import { projectEvmoleInterface } from "./EvmoleInterfaceAdapter.js";

it("preserves the actual producer keys, duplicates and unknown inference absence", () => {
  const raw = {
    functions: [
      { selector: "aabbccdd", bytecodeOffset: 1, dispatch: "abi" },
      {
        selector: "aabbccdd",
        bytecodeOffset: 2,
        dispatch: "fallback",
        arguments: "uint256",
        stateMutability: "view",
      },
    ],
  };
  const result = projectEvmoleInterface(raw);
  expect(result.raw).toEqual(raw);
  expect(result.functions).toEqual([
    {
      selector: "0xaabbccdd",
      bytecode_offset: 1,
      dispatch: "abi",
      inferred_arguments: null,
      inferred_state_mutability: null,
    },
    {
      selector: "0xaabbccdd",
      bytecode_offset: 2,
      dispatch: "fallback",
      inferred_arguments: "uint256",
      inferred_state_mutability: "view",
    },
  ]);
  expect(projectEvmoleInterface({}).functions).toEqual([]);
  const metadata = {
    bytecodeOffset: 1,
    cborLength: 4,
    entries: [
      { key: "reported", value: { type: "integer", value: 9007199254740992 } },
    ],
  };
  expect(
    projectEvmoleInterface({ functions: [], metadata }).raw.metadata,
  ).toEqual(metadata);
  expect(
    projectEvmoleInterface({
      functions: [],
      storage: undefined,
      transientStorage: undefined,
      disassembled: undefined,
      basicBlocks: undefined,
      controlFlowGraph: undefined,
      metadata: undefined,
    }).functions,
  ).toEqual([]);
});
it.each([
  { functions: [{ selector: "bad", bytecodeOffset: 0, dispatch: "abi" }] },
  {
    functions: [{ selector: "aabbccdd", bytecodeOffset: -1, dispatch: "abi" }],
  },
  { metadata: {} },
])("rejects producer representations outside the selected profile", (raw) => {
  expect(() => projectEvmoleInterface(raw)).toThrow();
});
