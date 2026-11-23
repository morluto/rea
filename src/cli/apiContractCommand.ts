import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import {
  ArtifactResourceScope,
  projectArtifactCloseFailure,
} from "../resources/index.js";
import { API_CONTRACT_TOOL_CONTRACTS } from "../contracts/apiContractToolContracts.js";
import {
  API_CONTRACT_OPERATION as operation,
  API_CONTRACT_PROVIDER,
} from "../domain/apiContract/apiContract.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import {
  deliverWithService,
  type EvidenceInspectionService,
} from "./contractCommandRunners.js";

/** Standard one-shot publication keeps complete inventory Evidence for later offline pages. */
export const registerApiContractCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(API_CONTRACT_TOOL_CONTRACTS, operation),
    {
      description:
        "Inspect local OpenAPI JSON or GraphQL SDL declarations and field bindings offline",
      positionals: ["path"],
      callerPaths: ["path", "operations_path"],
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
      fields: {
        path: { description: "Local OpenAPI JSON or GraphQL SDL path" },
        format: {
          name: "contractFormat",
          description: "Input API contract syntax: OpenAPI JSON or GraphQL SDL",
        },
        operations_path: {
          description:
            "Local operation/fragment document, only with --contractFormat graphql-sdl",
        },
        view: {
          description:
            "JSON api-contract or graphql-contract page; requires --detail summary and --evidence_output",
        },
      },
    },
    deliverWithService(createApiContractService, API_CONTRACT_PROVIDER.id),
  );

/** One-shot contract inventory that owns the documents it opens. */
const createApiContractService = (): EvidenceInspectionService => {
  const resources = new ArtifactResourceScope();
  return {
    inspect: async (input, { signal }) => {
      const { inspectApiContractEvidence } =
        await import("../application/apiContract/ApiContractService.js");
      return inspectApiContractEvidence(input, resources, { signal });
    },
    close: () =>
      resources.close().catch((cause: unknown) => {
        throw projectArtifactCloseFailure(
          cause,
          API_CONTRACT_PROVIDER.id,
          operation,
        );
      }),
  };
};
