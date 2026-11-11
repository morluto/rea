import type { RizinInput } from "../domain/reverseEngineering.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/** Default one-shot presentation to plain text while retaining plugin availability. */
export const rizinCommand = (input: RizinInput): readonly string[] => [
  "-N",
  "-q",
  "-e",
  "scr.color=0",
  // Rizin 0.9.1 refuses -e asm.arch= and -e asm.bits= at startup. Once the
  // file is open it applies -a and -b, then the -e settings.
  ...(input.asm_arch === undefined ? [] : ["-a", input.asm_arch]),
  ...(input.asm_bits === undefined ? [] : ["-b", String(input.asm_bits)]),
  ...(input.asm_cpu === undefined ? [] : ["-e", `asm.cpu=${input.asm_cpu}`]),
  // A format loader can claim a raw image. Rizin 0.9.1's AVR loader turns
  // io.va off, so reads at the -m map return 0xff, and the BIOS loader moves
  // the map. -n skips the loaders, and Rizin maps file offset 0 at the base.
  ...(input.base_address === undefined ? [] : ["-n", "-m", input.base_address]),
  "-c",
  input.command,
  absoluteCallerPath(input.path),
];

/** What REA cannot attest about the decoder and map inputs it passed to Rizin. */
export const rizinCommandLimitations = (
  input: RizinInput,
): readonly string[] => [
  ...(input.asm_arch === undefined &&
  input.asm_bits === undefined &&
  input.asm_cpu === undefined
    ? []
    : [
        "REA does not confirm that Rizin applied the selected asm_* values. Rizin uses another arch or bits value when it cannot apply one, at most reporting it on stderr, and e asm.cpu echoes any value, so compare it with e asm.cpu=?.",
      ]),
  ...(input.base_address === undefined
    ? []
    : [
        "With base_address, REA passed -n and -m so that Rizin maps file offset 0 at that address as a raw image; REA does not confirm the map, which oml shows. -n skips Rizin's format loaders, so expect no sections, symbols or entry point, and arch, bits and byte order stay at Rizin's defaults unless the call selects them.",
      ]),
];
