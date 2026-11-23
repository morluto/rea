import type { Logger } from "pino";

import { createWebNetworkCaptureService } from "../composition/webNetworkCaptures.js";
import { WEB_NETWORK_CAPTURE_TOOL_CONTRACTS } from "../contracts/webNetworkCaptureToolContracts.js";
import { deliverCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** The descriptor path member as `callerInputs` names it. */
const DESCRIPTOR_PATH = "protobuf.schema.descriptor_set_path";

/** Expose offline historical capture inspection with the same selection contract as MCP. */
export const registerWebNetworkCaptureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(
      WEB_NETWORK_CAPTURE_TOOL_CONTRACTS,
      "inspect_web_network_capture",
    ),
    {
      description:
        "Inspect retained HAR, native mitmproxy, Fiddler SAZ or aioquic qlog records without fetching recorded URLs",
      positionals: ["capture_path", "format"],
      callerPaths: ["capture_path"],
      evidenceDelivery: true,
      flatten: {
        protobuf: {
          framing: {
            name: "protobufFraming",
            description: "Override framing for selected retained binary bodies",
          },
          body_pointers: {
            name: "protobufBodyPointer",
            description: "Exact body pointers; repeat to select several",
          },
          schema: {
            flatten: {
              descriptor_set_path: {
                name: "protobufSchema",
                description: "Local compiled FileDescriptorSet path",
                callerPath: true,
              },
              message_type: {
                name: "protobufMessage",
                description:
                  "Fully qualified message type in the descriptor set",
              },
            },
          },
        },
      },
      fields: {
        capture_path: { description: "Local capture path" },
        format: { description: "Producer capture format" },
        record_ordinals: {
          name: "record",
          description: "Zero-based producer ordinals; repeat to select several",
        },
        sensitive_values: {
          name: "sensitiveValue",
          description:
            "Literal string values explicitly marked sensitive; repeat as needed",
        },
      },
    },
    async (input, { signal, delivery, callerInputs }) => {
      const service = createWebNetworkCaptureService(environment);
      const descriptor = callerInputs[DESCRIPTOR_PATH] as string | undefined;
      return deliverCliAnalysisEvidence({
        run: () => service.inspect(input, { signal }),
        // Evidence keeps each caller path as the caller spelled it.
        callerInputPath: callerInputs.capture_path as string,
        ...(descriptor === undefined
          ? {}
          : { callerInputPaths: { descriptor_set_path: descriptor } }),
        service,
        providerId: "web-network-capture",
        operation: "inspect_web_network_capture",
        signal,
        detail: delivery!.detail,
        evidenceOutput: delivery!.evidenceOutput,
        sensitiveValues: input.sensitive_values ?? [],
      });
    },
  );
