import type {
  ProviderToolIdentification,
  ProviderVersionProbe,
} from "../application/reverse/ReverseEngineeringCommandPort.js";
import type { RizinInput } from "../domain/reverseEngineering.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

export const RIZIN_PROVIDER_IDENTITY = {
  id: "rizin",
  name: "Rizin",
  version: null,
} as const;

/**
 * The first `-v` line Rizin and radare2 print: a plain tool token, a version,
 * any build tokens, then `@ <os>-<arch>-<bits>` and an optional `, <package>`.
 * Rizin 0.9.1 prints `rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2
 * (Homebrew)`; radare2 6.1.8 prints `radare2 6.1.8 +0 abi:110 @
 * darwin-arm_64`. A line such as `Warning: 123 …` identifies nothing.
 */
const VERSION_BANNER =
  /^(?<tool>[A-Za-z][\w.+-]*) (?<version>\d[\w.+-]*)(?: [^\s@]+)* @ [A-Za-z0-9]+-[A-Za-z0-9]+[-_]\d+(?:, .*)?$/u;

/**
 * Read the `-v` banner of the executable that REA_RIZIN_COMMAND selected.
 * radare2 also accepts REA's argument list, so another tool is recorded with
 * a limitation rather than refused.
 */
export const identifyRizinTool = (
  banner: string,
): ProviderToolIdentification | undefined => {
  const match = VERSION_BANNER.exec(banner);
  const tool = match?.groups?.tool;
  const version = match?.groups?.version;
  if (tool === undefined || version === undefined) return undefined;
  if (tool === "rizin")
    return {
      identity: { ...RIZIN_PROVIDER_IDENTITY, version },
      limitations: [],
    };
  return {
    identity: { id: RIZIN_PROVIDER_IDENTITY.id, name: tool, version },
    limitations: [
      `REA_RIZIN_COMMAND selected ${tool} ${version}, not Rizin. REA ran it with Rizin's arguments; the output follows ${tool}'s command semantics, which REA has not verified.`,
    ],
  };
};

/** Identify the selected tool; the service probes before every command. */
export const RIZIN_VERSION_PROBE: ProviderVersionProbe = {
  arguments: ["-v"],
  identify: identifyRizinTool,
  assumedIdentity:
    "No -v banner identified the tool that REA_RIZIN_COMMAND selected; the provider name Rizin is assumed from that setting, not observed.",
};

/** Default one-shot presentation to plain text while retaining plugin availability. */
export const rizinCommand = (input: RizinInput): readonly string[] => [
  "-N",
  "-q",
  "-e",
  "scr.color=0",
  "-c",
  input.command,
  absoluteCallerPath(input.path),
];
