import { expect, it } from "vitest";
import { verifyGhidraInstructionFlow } from "../../../../scripts/lib/real-ghidra-instruction-flow.mjs";

const leaf = { address: "0x100", value: "rea_ghidra_inventory_leaf" };
// Static decoder controls from inventory.c; no fixture bytes are executed.
const controls = [
  ["0x200", "rea_ghidra_flow_return", "RET", "c3"],
  ["0x210", "rea_ghidra_flow_cleanup_return", "RET", "c21000"],
  ["0x220", "rea_ghidra_flow_shared_tail", "JMP", "ebfe"],
  ["0x230", "rea_ghidra_flow_trap", "UD2", "0f0b"],
] as const;

const observedInstruction = (
  address: string,
  mnemonic = "RET",
  bytes = "c3",
) => ({
  address,
  status: "decoded",
  mnemonic,
  bytes,
  operands: [{ raw: "0x10" }],
  flow: {
    kind: mnemonic === "RET" ? "return" : "branch",
    classification_evidence: [
      { source: "ghidra-listing-flow-type" },
      ...(mnemonic === "RET"
        ? [{ source: "ghidra-instruction-pcode", value: "RETURN" }]
        : []),
    ],
  },
  limitations: [],
});
const instructions = new Map([
  [leaf.address, observedInstruction(leaf.address)],
  ...controls.map(
    ([address, , mnemonic, bytes]) =>
      [address, observedInstruction(address, mnemonic, bytes)] as const,
  ),
]);
const call = async (
  operation: string,
  input: Readonly<Record<string, string>>,
) => {
  if (operation === "read_function_instructions")
    return { instructions: [`${input.procedure}: fixture`] };
  if (operation === "inspect_native_instruction")
    return input.address === "0x0"
      ? {
          status: "outside-memory",
          flow: { kind: "unavailable", classification_evidence: [] },
        }
      : instructions.get(input.address!);
  if (operation === "resolve_native_call_targets")
    return { status: "not-call" };
  if (operation === "resolve_containing_procedure")
    return { address: input.address };
  throw new Error(`Unexpected fixture operation ${operation}`);
};
const cli = async (_command: string, address: string) =>
  instructions.get(address);
const names = controls.map(([address, value]) => ({ address, value }));

it("checks every retained inventory control for an independently parsed x86-64 ELF", async () => {
  const result = await verifyGhidraInstructionFlow(
    call,
    [leaf, ...names],
    cli,
    {
      format: "elf",
      architecture: "x86_64",
    },
  );
  expect(result.explicit_x86_elf_controls).toBe(4);
  expect(result.decoded_pcode_return).toBe(true);
});

it.each(["all", "one"])(
  "refuses %s omitted source controls on x86-64 ELF",
  async (omission) => {
    await expect(
      verifyGhidraInstructionFlow(
        call,
        [leaf, ...(omission === "all" ? [] : names.slice(0, -1))],
        cli,
        { format: "elf", architecture: "x86_64" },
      ),
    ).rejects.toThrow(/Source fixture lacks expected decoder control/u);
  },
);

it.each([
  { format: "mach-o", architecture: "x86_64" },
  { format: "elf", architecture: "arm64" },
  { format: "pe", architecture: "x86_64" },
] as const)(
  "keeps controls non-applicable for $format/$architecture",
  async (target) => {
    const result = await verifyGhidraInstructionFlow(call, [leaf], cli, target);
    expect(result.explicit_x86_elf_controls).toBe(0);
    expect(result.generic_unknown_preserved).toBe(true);
    expect(result.explicit_control_scope).toContain("Not compiled");
  },
);

it.each([0, 1, 4])(
  "keeps explicit unknown applicability with %i observed controls",
  async (observed) => {
    const result = await verifyGhidraInstructionFlow(
      call,
      [leaf, ...names.slice(0, observed)],
      cli,
      null,
    );
    expect(result.explicit_x86_elf_controls).toBe(observed);
    expect(result.explicit_control_scope).toContain("Unknown");
  },
);
