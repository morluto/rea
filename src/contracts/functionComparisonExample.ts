import { enhancedInputSchemas } from "./enhancedInputs.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

const bounded = <Item>(items: readonly Item[]) => ({
  items,
  total: items.length,
  returned: items.length,
  truncated: false,
  next_offset: null,
});

const dossier = (text: string) =>
  jsonValueSchema.parse({
    procedure: {
      address: "0x1000",
      name: "main",
      signature: "int main(void)",
      locals: [],
    },
    pseudocode: {
      text,
      total_chars: [...text].length,
      returned_chars: [...text].length,
      truncated: false,
      next_offset: null,
    },
    assembly: bounded([]),
    comments: bounded([]),
    callers: bounded([]),
    callees: bounded([]),
    incoming_references: bounded([]),
    outgoing_references: bounded([]),
    referenced_strings: bounded([]),
    referenced_names: bounded([]),
    basic_blocks: bounded([{ start: "0x1000", end: "0x1001", successors: [] }]),
    instruction_scan: { scanned: 1, truncated: false },
  });

const observe = (digit: string, text: string) =>
  createEvidence(
    {
      path: `/tmp/function-${digit}`,
      sha256: digit.repeat(64),
      format: "mach-o",
    },
    {
      id: "rea-workflow",
      name: "REA composed investigation workflow",
      version: "1",
    },
    {
      operation: "analyze_function",
      parameters: enhancedInputSchemas.analyze_function.parse({
        procedure: "main",
      }),
      result: dossier(text),
      confidence: "derived",
      authority: "shipped-artifact",
    },
  );

/** Canonical explicit function pair used in public contract examples. */
export const FUNCTION_COMPARISON_EXAMPLE = {
  left: observe("0", "return 0;"),
  right: observe("1", "return 1;"),
} as const;
