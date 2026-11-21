import type {
  CommandRefusal,
  CommandRejection,
} from "../domain/commandObservation.js";
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
  "Rizin commands and retained plugins may read files or access network resources outside the selected artifact; those external inputs are not bound to Evidence.",
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
  readonly reason: CommandRefusal["reason"];
  /** The named command's capture group, when the line names one. */
  readonly command?: 1;
  readonly refused: (command: string | null) => string;
}[] = [
  {
    line: /^ERROR: Command '(.*)' does not exist\.$/u,
    reason: "unknown_command",
    command: 1,
    refused: (command) => `the unknown command ${JSON.stringify(command)}`,
  },
  {
    line: /^ERROR: Wrong number of arguments passed to `(.*)`, see its help with `.*\?`$/u,
    reason: "wrong_argument_count",
    command: 1,
    refused: (command) =>
      `a wrong argument count for ${JSON.stringify(command)}`,
  },
  {
    line: /^ERROR: core: Error while executing command: /u,
    reason: "invalid_statement",
    refused: () => "an invalid statement",
  },
  {
    line: /^ERROR: core: Error while parsing command: /u,
    reason: "parse_failure",
    refused: () => "input that failed to parse",
  },
];

/** The first Rizin shell refusal in a completed process's stderr. */
export const rizinCommandRejection = (
  stderr: string,
): CommandRejection | undefined => {
  for (const text of stderr.split(/\r?\n/u))
    for (const { line, reason, command, refused } of RIZIN_SHELL_REFUSALS) {
      const match = line.exec(text);
      if (match === null) continue;
      const named = command === undefined ? null : (match[command] ?? null);
      return {
        refusal: { reason, command: named, line: text },
        limitation: `Rizin refused ${refused(named)} (ERROR line on stderr, recorded in refusal). It skips a refused statement and every later one, so stdout holds at most the output of earlier statements; empty stdout is not an empty result. Correct the statement, using <command>? for Rizin's help, and run it again.`,
      };
    }
  return undefined;
};
