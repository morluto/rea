import type { Logger } from "pino";
import { createWebSourceLocationService } from "../composition/webSourceLocations.js";
import { WEB_SCRIPT_TOOL_CONTRACTS } from "../contracts/webScriptToolContracts.js";
import { deliverCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Expose the same explicit selected map/point contract through the CLI. */
export const registerWebSourceLocationCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createWebSourceLocationService(environment);
  registerContractCommand(
    cli,
    logger,
    contractNamed(WEB_SCRIPT_TOOL_CONTRACTS, "trace_web_source_location"),
    {
      description:
        "Trace one retained script position through an explicitly selected local source map",
      positionals: [
        "manifest_path",
        "script_index",
        "source_map",
        "generated_position",
      ],
      callerPaths: ["manifest_path"],
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
      flatten: {
        source_map: {
          path: {
            name: "sourceMapPath",
            callerPath: true,
            description:
              "Local source-map path, not fetched; a relative path resolves against the current directory",
          },
          url: { name: "sourceMapUrl" },
        },
        generated_position: {
          line: { description: "One-based generated line" },
          column: { description: "Zero-based UTF-16 generated column" },
        },
        source_map_limits: {
          map_bytes: { name: "sourceMapBytes" },
          output_bytes: { name: "sourceMapOutputBytes" },
          decoded_rows: { name: "sourceMapDecodedRows" },
          decoded_segments: { name: "sourceMapDecodedSegments" },
          decoded_records: { name: "sourceMapDecodedRecords" },
          section_depth: { name: "sourceMapSectionDepth" },
          codec_heap_mib: { name: "sourceMapCodecHeapMib" },
        },
      },
      fields: {
        manifest_path: {
          description:
            "export_web_scripts manifest path; a relative path resolves against the current directory",
        },
        script_index: { description: "Zero-based manifest script index" },
        view: {
          description:
            "JSON source-location matches/source-text view; requires --detail summary and --evidence_output",
        },
      },
    },
    (input, { signal, operation, delivery }) => {
      if (delivery === undefined)
        throw new Error(`${operation} delivers Evidence`);
      return deliverCliAnalysisEvidence({
        run: () => service.trace(input, { signal }),
        service,
        providerId: "web-source-location",
        operation,
        signal,
        detail: delivery.detail,
        evidenceOutput: delivery.evidenceOutput,
        rerunRecoversResult: delivery.rerunRecoversResult,
        ...(delivery.view === undefined ? {} : { view: delivery.view }),
      });
    },
  );
};
