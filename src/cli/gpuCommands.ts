import type { Logger } from "pino";

import { createGpuCodeObjectsService } from "../composition/gpu.js";
import { GPU_TOOL_CONTRACTS } from "../contracts/gpu/gpuToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { deliverWithService } from "./contractCommandRunners.js";
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
        max_object_bytes: {
          description:
            "Maximum bytes per GPU object read or decoded buffer (default and maximum 134217728)",
        },
        max_work_bytes: {
          description:
            "Maximum aggregate payload input, decoded output, native-section, and AMDGPU note/structure bytes per inspection (default and maximum 536870912)",
        },
        max_report_bytes: {
          description:
            "Maximum bytes for retained GPU report facts, PTX text, Clang directories, and CUDA temporary indexes (default and maximum 16777216)",
        },
        max_metadata_bytes: {
          description:
            "Maximum AMDGPU ELF note and MessagePack metadata bytes (default and maximum 8388608)",
        },
        max_structure_bytes: {
          description:
            "Maximum bytes of one native ELF/PE section table or decoded section names (default 16777216, up to 536870912)",
        },
        max_parser_entries: {
          description:
            "Maximum entries per Clang bundle directory, PTX kernel/parameter list, or AMDGPU container (default and maximum 65536)",
        },
        max_parser_visits: {
          description:
            "Maximum aggregate CUDA record/symbol visits or AMDGPU MessagePack values per code object (default and maximum 262144)",
        },
        max_token_bytes: {
          description:
            "Maximum bytes per Clang bundle ID, PTX token, or AMDGPU MessagePack scalar (default and maximum 65536)",
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
