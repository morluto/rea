import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { COMPARE_SOURCE_TO_BUNDLE_TOOL_CONTRACT } from "../contracts/sourceToBundleToolContract.js";
import { registerContractDocumentCommand } from "./contractDocumentCommand.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";

/** The reference file path exactly as the caller spelled it, if any. */
const spelledReferencePath = (document: unknown): string | undefined => {
  if (typeof document !== "object" || document === null) return undefined;
  const reference = (document as { readonly reference?: unknown }).reference;
  if (typeof reference !== "object" || reference === null) return undefined;
  const path = (reference as { readonly path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
};

/** CLI file transport delegates graph authentication and comparison to the same owners as MCP. */
export const registerSourceToBundleCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    COMPARE_SOURCE_TO_BUNDLE_TOOL_CONTRACT,
    {
      description:
        "Compare historical source (inline graph or reference {kind:file,path}) with authenticated application Evidence. Save the complete JSON to query with inspect-analysis-view.",
      document: "Inline workflow JSON or JSON file path",
      callerPaths: [["reference", "path"]],
      omit: {
        view: "A one-shot command retains no session Evidence for a selected view; save the complete comparison and query it with inspect-analysis-view",
      },
      cliOptions: { evidenceBundle: evidenceBundleOption },
    },
    async (document, { signal, operation, spelled, frame, cliOptions }) => {
      const requestedReferencePath = spelledReferencePath(spelled);
      const result = await runEvidenceInputCommand(
        document,
        { operation, signal, frame, cliOptions },
        async (lookup, resources) => {
          const { executeSourceToBundleComparison } =
            await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
          const compared = await executeSourceToBundleComparison(
            document,
            lookup,
            resources,
            {
              signal,
              ...(requestedReferencePath === undefined
                ? {}
                : { requestedReferencePath }),
            },
          );
          return compared.ok
            ? { ok: true, value: compared.value.evidence }
            : compared;
        },
      );
      return result.ok
        ? result.value
        : { error: "Application workflow failed", ...result.error };
    },
  );
