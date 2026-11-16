import type { ObjdumpSelection } from "../domain/reverseEngineering.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/** Build GNU objdump argv without invoking a shell or following DWARF links by default. */
export const objdumpCommand = (input: ObjdumpSelection): readonly string[] => {
  if (input.operation === "architectures") return ["-i"];
  const argumentsByOperation = {
    file_headers: ["-f"],
    section_headers: ["-h"],
    symbols: ["-t"],
    relocations: ["-r"],
    dwarf: ["-W", input.follow_debug_links ? "-WK" : "-WN"],
    disassemble:
      input.operation === "disassemble" && input.symbol !== undefined
        ? [`--disassemble=${input.symbol}`]
        : ["-d"],
    disassemble_all: ["-D"],
  } satisfies Record<typeof input.operation, readonly string[]>;
  return [
    ...argumentsByOperation[input.operation],
    absoluteCallerPath(input.path),
  ];
};

/** What REA cannot attest about the objdump command it built for `input`. */
export const objdumpCommandLimitations = (
  input: ObjdumpSelection,
): readonly string[] => [
  ...(input.operation === "architectures"
    ? [
        "The objdump implementation and version are unknown. The captured output is the selected command's response and does not establish support for an artifact.",
      ]
    : []),
  ...(input.operation === "disassemble" && input.symbol !== undefined
    ? [
        "Disassembly is scoped to the caller-selected symbol using the provider's matching and symbol-boundary semantics; an empty match does not establish artifact-wide absence.",
      ]
    : []),
  ...(input.operation === "dwarf" && input.follow_debug_links === true
    ? [
        "DWARF output may include local debug-link files whose identities are not bound to Evidence.",
      ]
    : []),
];
