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

/** What REA cannot attest about command outcomes and selected decoder/map inputs. */
export const rizinCommandLimitations = (
  input: RizinInput,
): readonly string[] => [
  "completion_status covers process completion and Rizin shell refusals only. A statement that ran can still fail while Rizin returns exit_code 0, so inspect stderr before treating an empty response as absence.",
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

/**
 * Rizin's shell logs exactly these lines when it refuses a statement
 * (librz/core/cmd/cmd.c, unchanged from 0.6 through 0.9.1). Rizin then skips
 * the remaining statements and still exits 0. Other ERROR lines come from
 * commands that ran, so they are diagnostics rather than refusals.
 */
const RIZIN_SHELL_REFUSALS: readonly {
  readonly line: RegExp;
  readonly refused: (match: RegExpExecArray) => string;
}[] = [
  {
    line: /^ERROR: Command '(.*)' does not exist\.$/u,
    refused: (match) => `the unknown command ${JSON.stringify(match[1])}`,
  },
  {
    line: /^ERROR: Wrong number of arguments passed to `(.*)`, see its help with `.*\?`$/u,
    refused: (match) =>
      `a wrong argument count for ${JSON.stringify(match[1])}`,
  },
  {
    line: /^ERROR: core: Error while executing command: /u,
    refused: () => "an invalid statement",
  },
  {
    line: /^ERROR: core: Error while parsing command: /u,
    refused: () => "input that failed to parse",
  },
];

/** Explain the first Rizin shell refusal in a completed process's stderr. */
export const rizinCommandRejection = (stderr: string): string | undefined => {
  for (const text of stderr.split(/\r?\n/u))
    for (const { line, refused } of RIZIN_SHELL_REFUSALS) {
      const match = line.exec(text);
      if (match !== null)
        return `Rizin refused ${refused(match)} (ERROR line on stderr). It skips a refused statement and every later one, so stdout holds at most the output of earlier statements; empty stdout is not an empty result. Correct the statement, using <command>? for Rizin's help, and run it again.`;
    }
  return undefined;
};
