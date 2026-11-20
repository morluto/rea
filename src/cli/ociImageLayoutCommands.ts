import type { Logger } from "pino";

import { createOciImageLayoutService } from "../composition/ociImageLayout.js";
import { OCI_IMAGE_LAYOUT_TOOL_CONTRACTS } from "../contracts/oci/ociImageLayoutToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Inspect operator-selected OCI image layouts through the same shared workflow as MCP. */
export const registerOciImageLayoutCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(OCI_IMAGE_LAYOUT_TOOL_CONTRACTS, "inspect_oci_image_layout"),
    {
      description:
        "Inspect an OCI image-layout directory: indexes, manifests, config, layers and blob digests, without decompressing layers or contacting a registry",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: {
        path: { description: "Local OCI image-layout directory" },
        include_env_values: {
          description:
            "Include config Env values (default true); false leaves each value null and keeps only the names",
        },
      },
    },
    deliverWithService(createOciImageLayoutService, "rea-oci-image-layout"),
  );
};
