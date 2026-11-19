import type { Logger } from "pino";

import { createGpuCodeObjectsService } from "../composition/gpu.js";
import { GPU_TOOL_CONTRACTS } from "../contracts/gpu/gpuToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** One-shot summaries export the same complete observations used by MCP retained pages. */
export const registerGpuCommands = (cli: CliInstance, logger: Logger): void => {
  const deliver = deliverWithService(
    createGpuCodeObjectsService,
    "gpu-code-objects",
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(GPU_TOOL_CONTRACTS, "inspect_gpu_code_objects"),
    {
      description:
        "Inspect embedded CUDA/HIP targets and selected static kernel metadata",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      viewDelivery: {
        invalidJson: "view must be valid JSON",
        kind: "gpu-code-objects",
      },
      runtimeJson: {
        object_ids: "object_ids must be valid JSON",
        targets: "targets must be valid JSON",
      },
      fields: {
        path: {
          description: "Local ELF/PE, CUDA fatbin, CUBIN, PTX or HIP bundle",
        },
        analysis: {
          description:
            "Inventory GPU targets or decode selected kernel metadata",
        },
        expected_sha256: {
          name: "expected_sha256",
          description:
            "Inventory SHA-256 as 64 lowercase hex digits; required with --object_ids",
        },
        object_ids: {
          name: "object_ids",
          description: "JSON array of exact object IDs to decode",
        },
        targets: {
          description: "JSON array of exact target declarations to decode",
        },
        view: {
          description:
            "JSON GPU object/kernel/PTX page selection; requires --detail summary and --evidence_output",
        },
      },
    },
    // The CLI delivers the summary itself, so the service returns complete
    // Evidence; the contract's own default would retain a summary instead.
    (input, context) => deliver({ ...input, detail: "complete" }, context),
  );
};
