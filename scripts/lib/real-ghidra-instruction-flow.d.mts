import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";

/** Check source-owned inventory controls using independently parsed target facts. */
export function verifyGhidraInstructionFlow(
  call: (
    operation: string,
    parameters: Readonly<Record<string, string>>,
  ) => Promise<unknown>,
  names: readonly { readonly address: string; readonly value: string }[],
  cli: (command: string, address: string) => Promise<unknown>,
  target: Pick<BinaryTarget, "format" | "architecture"> | null,
): Promise<{
  readonly return_instruction: string;
  readonly decoded_pcode_return: true;
  readonly return_cli_mcp_parity: true;
  readonly explicit_x86_elf_controls: number;
  readonly explicit_control_scope: string;
  readonly generic_unknown_preserved: true;
}>;
