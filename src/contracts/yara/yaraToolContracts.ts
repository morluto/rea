import {
  inspectYaraMatchesInputSchema,
  yaraMatchesSchema,
} from "../../domain/yara/yaraMatches.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata, toolEffects } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Caller-supplied YARA rules run by the caller-selected yara command. */
export const YARA_TOOL_CONTRACTS = [
  {
    name: "inspect_yara_matches",
    cli: true,
    ...toolContractMetadata(
      "inspect_yara_matches",
      toolEffects({
        mutatesSession: true,
        launchesProcess: true,
        writesFilesystem: true,
      }),
    ),
    kind: "artifact-provider",
    description:
      "Scan one local file with caller-supplied YARA rule files using the installed yara command (REA_YARA_COMMAND or yara on PATH). The file is read, never executed; REA bundles no rules and downloads nothing. Returns matching rules with tags, metadata and string match offsets, bound to the file SHA-256 and each rule file SHA-256. String matches beyond max_matches are counted and coverage is partial. Rule compile errors are input errors naming the rule file. command_timeout_ms, max_output_bytes and max_matches also have runtime settings; max_file_bytes bounds the scanned file and each rule file. Complete Evidence is the result.",
    inputSchema: inspectYaraMatchesInputSchema,
    outputSchema: evidenceResultOf(yaraMatchesSchema),
    examples: [
      {
        title: "Scan a sample with a local rule file",
        input: {
          path: "/artifacts/sample.bin",
          rule_paths: ["/rules/packers.yar"],
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
