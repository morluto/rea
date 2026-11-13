import {
  environmentBuildReportSchema,
  exportEnvironmentBundleInputSchema,
} from "../domain/environmentBundleExport.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

/** Agent environment bundle contracts shared with the environment-build CLI command. */
export const ENVIRONMENT_TOOL_CONTRACTS = [
  {
    name: "export_environment_bundle",
    ...toolContractMetadata("export_environment_bundle"),
    description:
      "Write an agent environment bundle from capture_browser_scenario Evidence or HAR inspect_web_network_capture Evidence to an absent absolute output_directory whose parent exists. Copies complete capture Evidence, including recorded bodies, and derives replay/state read tools and served/withheld writes with coverage and next-recording hints. Preview the same coverage with inspect_analysis_view kind environment-coverage. dry_run reports without writing but still validates the destination. Uses default template rules, reads only selected Evidence and optional package_tarball, and writes only that directory; no network access. The bundle README explains agentenv use. Destination refusals name this tool; other failures name their export stage.",
    kind: "application",
    inputSchema: exportEnvironmentBundleInputSchema,
    outputSchema: environmentBuildReportSchema,
    examples: [
      {
        title: "Write the bundle for a retained browser scenario capture",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id:
              "ev_0000000000000000000000000000000000000000000000000000000000000001",
          },
          output_directory: "/tmp/grafana-env",
          name: "grafana",
        },
      },
      {
        title: "Check what a capture file's bundle would serve",
        input: {
          source: { kind: "evidence-file", path: "/tmp/grafana.capture.json" },
          output_directory: "/tmp/grafana-env",
          dry_run: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
