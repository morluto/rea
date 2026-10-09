import { resolve } from "node:path";

import type { ObjdumpInput } from "../domain/reverseEngineering.js";

export const OBJDUMP_PROVIDER_IDENTITY = {
  id: "gnu.objdump",
  name: "GNU objdump",
  version: null,
} as const;

/** Build GNU objdump argv without invoking a shell or following DWARF links by default. */
export const objdumpCommand = (input: ObjdumpInput): readonly string[] => {
  const argumentsByOperation = {
    file_headers: ["-f"],
    section_headers: ["-h"],
    symbols: ["-t"],
    relocations: ["-r"],
    dwarf: ["-W", input.follow_debug_links ? "-WK" : "-WN"],
    disassemble: ["-d"],
    disassemble_all: ["-D"],
    architectures: ["-i"],
  } satisfies Record<ObjdumpInput["operation"], readonly string[]>;
  return [...argumentsByOperation[input.operation], resolve(input.path)];
};
